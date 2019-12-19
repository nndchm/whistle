var rules = require('../rules');
var util = require('../util');
var pluginMgr = require('../plugins');
var fileMgr = require('../util/file-mgr');
var getRawHeaderNames = require('hparser').getRawHeaderNames;

var HTTP_RE = /^https?:/;
var MAX_PAYLOAD_SIZE = 1024 * 256;

function resolveRules(req, callback, rules) {
  if (!rules) {
    return callback();
  }
  req.curUrl = req.fullUrl = util.getFullUrl(req);
  if (rules.initRules) {
    rules.initRules(req);
  } else {
    req.rules = rules.resolveRules(req);
  }
  var urlParamsRule = req.rules.urlParams;
  util.parseRuleJson(urlParamsRule, function(urlParams) {
    if (urlParams) {
      var _url = util.replaceUrlQueryString(req.url, urlParams);
      if (req.url !== _url) {
        req.url = _url;
        req.curUrl = req.fullUrl = util.getFullUrl(req);
        req.rules = rules.resolveRules(req);
        req.rules.urlParams = urlParamsRule;
        if (req.headerRulesMgr) {
          var _rules = req.rules;
          req.rules = req.headerRulesMgr.resolveRules(req);
          util.mergeRules(req, _rules);
        }
      }
    }
    callback();
  });
}

function setupRules(req, next) {
  resolveRules(req, function() {
    var _rules = req.rules;
    rules.resolveRulesFile(req, function() {
      pluginMgr.resolveWhistlePlugins(req);
      pluginMgr.getRules(req, function(pluginRules) {
        req.pluginRules = pluginRules;
        resolveRules(req, function() {
          if (pluginRules) {
            // 插件不支持rulesFile协议
            delete req.rules.rulesFile;
            var _pluginRules = req.rules;
            req.rules = _rules;
            util.mergeRules(req, _pluginRules);
          }

          var ruleUrl = util.rule.getUrl(req.rules.rule);
          if (ruleUrl !== req.fullUrl && HTTP_RE.test(ruleUrl)) {
            ruleUrl = util.encodeNonLatin1Char(ruleUrl);
          }
          req.options = util.parseUrl(ruleUrl || req.fullUrl);
          var rawNames = req.rawHeaderNames = Array.isArray(req.rawHeaders) ?
            getRawHeaderNames(req.rawHeaders) : {};
          rawNames.connection = rawNames.connection || 'Connection';
          rawNames['proxy-authorization'] = rawNames['proxy-authorization'] || 'Proxy-Authorization';
          next();
        }, pluginRules);
      });
    });
  }, rules);
}

function pipeStream(src, target) {
  if (!src || !target) {
    return src || target;
  }
  var srcPipe = src.pipe;
  src.pipe = function(stream) {
    return srcPipe.call(src, target).pipe(stream);
  };
  return src;
}

function getDecoder(obj) {
  return function(socket, callback) {
    var encoding = obj._originEncoding;
    var decoder;
    if (obj._needGunzip || socket || encoding !== obj.headers['content-encoding']) {
      obj._needGunzip = true;
      decoder = encoding && util.getUnzipStream(encoding);
    }
    if (socket) {
      delete obj.headers['content-length'];
    }
    callback(pipeStream(decoder, socket, true));
  };
}

function getEncoder(obj, req) {
  return function(socket, callback) {
    var encoding;
    if (req && req.enable.gzip && (obj._needGunzip || !obj._originEncoding)) {
      encoding = 'gzip';
    } else {
      encoding = obj._needGunzip && obj.headers;
    }
    var encoder = encoding && util.getZipStream(encoding);
    if (socket) {
      delete obj.headers['content-length'];
      obj.emit('bodyStreamReady', socket);
    }
    callback(pipeStream(socket, encoder));
  };
}

module.exports = function(req, res, next) {
  req.reqId = util.getReqId();
  req.curUrl = req.fullUrl = util.getFullUrl(req);
  req._originEncoding = req.headers['content-encoding'];
  req.onDecode = function(callback) {
    var decode = getDecoder(req);
    pluginMgr.getReqReadPipe(req, function(socket) {
      decode(socket, callback);
    });
  };
  req.onEncode = function(callback) {
    var encode = getEncoder(req);
    pluginMgr.getReqWritePipe(req, function(socket) {
      encode(socket, callback);
    });
  };
  res.onDecode = function(callback) {
    var decode = getDecoder(res, req);
    pluginMgr.getResReadPipe(req, res, function(socket) {
      decode(socket, callback);
    });
  };
  res.onEncode = function(callback) {
    var encode = getEncoder(res, req);
    pluginMgr.getResWritePipe(req, res, function(socket) {
      encode(socket, callback);
    });

  };
  pluginMgr.resolvePipePlugin(req, function() {
    var reqReadPort = req._pipePluginPorts.reqReadPort;
    if (reqReadPort || req._pipePluginPorts.reqWritePort) {
      delete req.headers['content-length'];
    }
    rules.initHeaderRules(req, true);
    var hasBodyFilter = rules.resolveBodyFilter(req);
    req._bodyFilters = null;
    if (hasBodyFilter || reqReadPort) {
      req._needGunzip = true;
      var payloadSize = MAX_PAYLOAD_SIZE;
      if (!hasBodyFilter) {
        payloadSize = rules.hasReqScript(req) ? 0 : 1;
      }
      req.getPayload(function (err, payload) {
        req._reqBody = fileMgr.decode(payload);
        setupRules(req, next);
      }, payloadSize);
    } else {
      setupRules(req, next);
    }
  });
};

