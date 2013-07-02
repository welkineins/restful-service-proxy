var restify = require("restify"),
	url     = require("url"),
	redis   = require("redis"),
	_       = require("underscore");

var server;

module.exports.createRuntime = function(opt) {
	opt = opt || {};

	if( ! opt.redis) {
		opt.redis = redis.createClient();
	}

	server = restify.createServer();
	server.use(restify.bodyParser({mapParams: false}));

	function serviceHandler(req, res, next) {
		var info = JSON.parse(req.headers["x-service-execution"]);

		// loading local service
		try {
			var service = require(info.module_path);
			service.init({
				prefix: info.policy.uri, 
				proxy: info.proxy,
				redis: redis,
				runtime: "proxy",
			});
		} catch(err) {
			console.log("[Error] Load service error: " + err);
			return next(err);
		}

		// leave only service params part of url
		var _req = _.clone(req),
			query = url.parse(req.url);
		_req.url = query.path;

		// run local service. if not success, forward the request to remote
		service.route(_req, res, next);
		console.log("[OK] Local served [" + req.url + "]");
	}

	["get", "head", "post", "put", "del"].forEach(function(method) {
		server[method](/.*/, serviceHandler);
	});

	return module.exports;
}

module.exports.listen = function(port, host) {
	server.listen(port, host);
}

