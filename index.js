var httpProxy  = require('http-proxy'),
	url        = require('url'),
	redis      = require('redis'),
	os         = require('os'),
	vm         = require('vm'),
	regEscape  = require('escape-regexp'),
	userPolicyParser = require('./lib/user-policy-header-parser.js'),
	child      = require('child_process'),
	utility    = require('./lib/utility.js');

var proxyPort     = 8000,
	runtimePort   = 6666,
	moduleTmpPath = "./tmp/modules/",
	modulePath    = "./public/modules/";

var rdb  = redis.createClient(),
	resourceFlag = true;

// -- Initialize Redis
// -----------------------------------------------------

rdb.on("ready", function(err) {
	if(err) {
		console.log("[Error] Can't connect to Redis: " + err);
		return;
	}
	rdb.set("utility:default", "function func(x) { return 1; }", function(err, reply) {
		if(err) {
			console.log("[Error] Redis initialization failed: " + err);
		}
	});
});

// -- Resource Monitoring
// -----------------------------------------------------
// Monitoring system resources every 1 sec, and changing
// resourceFlag which can decide whether running local 
// service or not
// -----------------------------------------------------

setInterval(function resourceMonitor() {
	if(os.freemem() / os.totalmem() > 0.9) {
		resourceFlag = false;
	}

	if(os.loadavg()[0] / os.cpus().length > 0.8) {
		resourceFlag = false;
	}

	resourceFlag = true;
}, 100); //ms

function resourceCheck(info) {
	if( ! resourceFlag) {
		return false;
	}
	return true;
}


// -- Utility Check
// -----------------------------------------------------
// Check user utility can be satisfy or not before a new 
// service ready to run, otherwise, it should forward 
// the reques.
// -----------------------------------------------------

// Calculate cumulative attribute values and estimated 
// attribute value. Then we can calculate expected utility 
// valus u^proxy, u^cloud.
function utilityCheck(utilities, req, policy, service) {
	if(req.url.match(/mashup\/do/)) {
		return true;
	}

	if(policy["no-forward"]) {
		console.log("[INFO] No-forward flag on");
		return true;
	}

	req.utility.setTimeUtilityFunction(new Function(["t"], utilities[0] + ";return func(t);"));
	req.utility.setTransferDataUtilityFunction(new Function(["d"], utilities[1] + ";return func(d);"));
	req.utility.setCurrentTime();
	req.utility.setReqData(parseInt(req.headers["content-length"]));

	var proxyTime1 = parseInt(policy.pt1) || 0.08,
		cloudTime1 = parseInt(policy.ct1) || 0.036
		proxyTime2 = parseInt(policy.pt2) || 1.31,
		cloudTime2 = parseInt(policy.ct2) || 1.26;

	var ptime = (req.url.match(/preprocess$/)) ? proxyTime1 : proxyTime2,
		ctime = (req.url.match(/preprocess$/)) ? cloudTime1 : cloudTime2;

	var upstreamUtility = req.utility.calcUtilityAtUpstream({
		time: ctime,
		reqData: parseInt(req.headers["content-length"]),
		resData: parseInt(req.headers["content-length"]),
	});
	
	var proxyUtility = req.utility.calcUtilityAtProxy({
		time: ptime,
		transferData: 0,
		transferNum: 0,
	});
	
	console.log("[INFO] utility: " + JSON.stringify([proxyUtility, upstreamUtility]));

	return (proxyUtility >= upstreamUtility);
}

// -- Proxying
// --------------------------------------------------------
// Main processing enter point, it basicly follow the request
// process flow chart in application protocol. 
// 1. incoming request
// 2. check service module & service policy by lookup record in redis
// 3. first utility check whether to providing service or not
// 4a. proxy to local service runtime 
// 5b. proxy to remore server (Cloud)
// --------------------------------------------------------

function forward(proxy, req, res, proxyOpt) {
	/*if(req.userPolicy["no-forward"]) {
		res.writeHead(440, {"Content-Length": "0"}); // an unused status code
		res.end();
		return;
	}*/
	proxy.proxyRequest(req, res, proxyOpt);
}

httpProxy.setMaxSockets(1024);
var server = httpProxy.createServer(function(req, res, next) {
	// Security check
	var ips = [
		"140.113.216.105",
		"140.113.235.158",
		"140.113.235.157",
		"127.0.0.1",
	];

	ips.forEach(function(ip){
		if(req.connection.remoteAddress == ip) {
			next();
			return false;
		}
	});
}, function(req, res, proxy) { // HTTP Proxy
	var query  = url.parse(req.url),
	    buffer = httpProxy.buffer(req),
		proxyOpt = {
			host: query.hostname,
			port: query.port || 80,
			buffer: buffer
		};

	// Check user preference
	req.utility    = utility.createUtility();
	req.userPolicy = userPolicyParser.parse(req.headers["user-policy"]);
	
	if(req.userPolicy["no-served"]) {
		// This flag can prevent down module and policy again
		res.local_served = true;
		forward(proxy, req, res, proxyOpt);
		console.log("[Info] Forwarded since no-served flag found.");
		return;
	}

	// Initialize attributes of resopnse time and transfer data
	req.userPolicy.t = parseInt(req.userPolicy.t) || 0;
	req.userPolicy.d = parseInt(req.userPolicy.d) || 0;
	req.utility.setCumulativeTime(req.userPolicy.t);
	req.utility.setCumulativeData(req.userPolicy.d);
	req.utility.setStartTime();

	// Look up local services by key which is a domain/host 
	var key = "service:" + query.protocol + "//" + query.host + "*";
	rdb.keys(key, function(err, reply) {
		if(err) {
			console.log("[Error] Lookup domain failed: " + err);
			forward(proxy, req, res, proxyOpt);
			return;
		}

		if(reply.length == 0) {
			console.log("[Info] No match domain founded, forwarded: " + query.href);
			forward(proxy, req, res, proxyOpt);
			return;
		}
		
		// Domain is match now, then try to matching service name
		var service_name = "";
			
		// Use the longest match one
		reply.forEach(function(item) {
			var pattern = new RegExp("^"+ regEscape(item.replace(/^service:/, "")) + ".*")
			if(query.href.match(pattern) && (item.length > service_name.length)) {
				service_name = item;
			}
		});

		if(service_name == "") {
			console.log("[Info] No match service founded, forwarded: " + query.href);
			forward(proxy, req, res, proxyOpt);
			return;
		}

		// We know which service to run, look up for service information
		rdb.get(service_name, function(err, reply) {
			if(err) {
				console.log("[Error] Lookup service info failed: " + err);
				forward(proxy, req, res, proxyOpt);
				return;
			}

			// This flag can prevent down module and policy again
			res.local_served = true;

			var info = JSON.parse(reply);

			// PRE-CONDITIONS CHECK
			// --------------------

			// Check resources status and user preferences to make
			// sure that user take benefit from running service
			// locally.
			if( ! resourceCheck(info)) {
				console.log("[Warn] Resource check failed, forwarded: " + query.href);
				forward(proxy, req, res, proxyOpt);
				return;
			}
			

			// UTILITY CHECK
			// --------------------

			// Next, we query all provided utility functions from redis to check
			// whether executing local service can provide better utility or not.
			// If not, then we should not do it.
			var utilities = [
				"utility:" + req.userPolicy.responseTime,
				"utility:" + req.userPolicy.dataTransferSize,
			]; 

			rdb.mget(utilities, function(err, reply) {
				if(err) {
					console.log("[Error] Lookup utility function failed: " + err);
					forward(proxy, req, res, proxyOpt);
					return;
				}

				// Are there unknown untility function ? 
				// Yes: forward request and download it
				var test = true;
				for(var i = 0; i < reply.length; ++i) {
					if( ! reply[i]) {
						test = false;
						getUtility(utilities[i].replace(/^utility:/, ""));
					}
				};

				if( ! test) {
					console.log("[Info] Some utility function not found, downloading, forwarded: " + query.href);
					forward(proxy, req, res, proxyOpt);
					return;                                                       
				}

				// early utilty cehck
				if( ! utilityCheck(reply, req, req.userPolicy, info)) {
					console.log("[Warn] Utility check failed, forwarded: " + query.href);
					forward(proxy, req, res, proxyOpt);
					return;
				}

				// Yes, that's serve locally. Passing info data to local
				// service runtime by storing them in the request header.
				var msg = {
					service: info,
					proxy: "http://127.0.0.1:" + proxyPort,
					userPolicy: req.userPolicy,
					utility: req.utility.toString(),
				};
				req.headers["x-service-execution"] = JSON.stringify(msg);
				
				proxy.proxyRequest(req, res, {
					host: "127.0.0.1",
				    port: runtimePort,
				    buffer: buffer
				});
			}); // mget
		}); // get
	}); // keys
});

// -- Download Service Module, Policy, Utility Function
// -----------------------------------------------------
// When receiving a non-local served response, trying to fetch
// service module, service policy and utility functions specified
// in this pollicy by checking link header in response.
// -----------------------------------------------------
var fetcher = child.fork("./standalone-fetcher.js", [moduleTmpPath, modulePath]);

// Listen on end event of proxy, which emitted on the response is
// generated (finish proxying). We check whether to fetch service
// module, policy, utility function or not there.
server.proxy.on("end", function(req, res, response) {
	// if this service response is generated by local server,
	// we don't need to fetch them
	if(res.local_served) {
		return;
	}

	fetcher.send({
		type: "module", 
		opt: {
			linkHeader: res.getHeader("Link"),
			url: req.url,
		}
	});
});

function getUtility(url) {
	fetcher.send({
		type: "utility",
		opt: {
			url: url,
		}
	});
}

// -- Start Proxying
// ------------------------------------------------------
var runtime = child.fork("./standalone-runtime.js", [runtimePort]);
server.listen(proxyPort, function() {
	console.log("P-Proxy is running on port: " + proxyPort + " (runtime: " + runtimePort + ")");
});

// -- End of Proxy
// ------------------------------------------------------
process.on("exit", function() {
	fetcher.kill("SIGKILL");
	runtime.kill("SIGKILL");
});

/* End of file index.js */

