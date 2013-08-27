var restify = require("restify"),
	url     = require("url"),
	redis   = require("redis"),
	_       = require("underscore"),
	userPolicyParser = require("./lib/user-policy-header-parser.js"),
	utility = require("./lib/utility.js");

var server;

// -- Create runtime instance
// -------------------------------------------
// Create a instance of runtime which will
// forward the incoming reuest to responable module
// to generate response.
// -------------------------------------------

module.exports.createRuntime = function(opt) {
	opt = opt || {};

	if( ! opt.redis) {
		opt.redis = redis.createClient();
	}

	server = restify.createServer();
	server.use(restify.bodyParser({mapParams: false}));

	function serviceHandler(req, res, next) {

		// deserialize JSON object from proxy
		var msg = JSON.parse(req.headers["x-service-execution"]);
		req.userPolicy = msg.userPolicy;
		req.utility = utility.createUtility().parse(msg.utility);

		// loading local service
		try {
			var service = require(msg.service.module_path);
			service.init({
				prefix: msg.service.policy.uri, 
				proxy: msg.proxy,
				rdis: redis,
				runtime: "proxy",
				userPolicy: msg.userPolicy,
			});
		} catch(err) {
			console.log("[Error] Load service error: " + err);
			return next(err);
		}

		// leave only service params part of url
		var _req  = _.clone(req),
			query = url.parse(req.url);
		_req.url = query.path;
	
		// run local service.
		res.setHeader("X-Count", "1"); // count how many service are running on poryx (experiment only)
		service.route(_req, res, next);
		console.log("[OK] Local served [" + req.url + "]");
	}

	["get", "head", "post", "put", "del"].forEach(function(method) {
		server[method](/.*/, serviceHandler);
	});

	return module.exports;
}

// -- Listen
// ------------------------------------------
// Listen on port to start service
// ------------------------------------------

module.exports.listen = function(port, host) {
	server.listen(port, host);
}

/* End of file service-runtime.js */

