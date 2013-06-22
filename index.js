var httpProxy  = require('http-proxy'),
	http       = require('http'),
	url        = require('url'),
	linkParser = require('parse-link-header'),
	redis      = require('redis'),
	async      = require('async'),
	fs         = require('fs'),
	request    = require('request'),
	npm        = require('npm'),
	targz      = require('tar.gz'),
	mkdirp     = require('mkdirp')
	router     = require('http-router'),
	_          = require('underscore'),
	os         = require('os'),
	regEscape  = require('escape-regexp'),
	restify    = require('restify'),
	bodyParser = require('connect/lib/middleware/bodyParser'),
	userPolicy = require('./lib/user-policy-header-parser.js');

require('router');

var proxyPort     = 8000,
	serverPort    = 7777,
	moduleTmpPath = "./tmp/modules/",
	modulePath    = "./public/modules/";

var rdb  = redis.createClient(),
	rest = restify.createServer();

rdb.on("on", function(err) {
	console.log("Can't connect to Redis: " + err);
});

rest.use(restify.bodyParser({mapParams: false}));

function serviceHandler(req, res, next) {
	// loading local service
	try {
		var service = require(req.info.module_path);
	    service.init({proxy: '127.0.0.1:' + proxyPort});
	} catch(err) {
		console.log("Load service error: " + err);
	    return next(err);
	}

	// leave only service params part of url
	var _req = _.clone(req);
	_req.url = "/" + req.params[1];

	// run local service. if not success, forward the request to remote
	if(service.route(_req, res)) {
		// set up flag to prevent download module & policy for this response
	    res.local_served = true;
		console.log("local served");
	} else {
		console.log("local service error");
		res.send(500);
	}
}

rest.get(/^\/([a-zA-Z0-9_\.~-]+)\/(.*)/, serviceHandler);
rest.head(/^\/([a-zA-Z0-9_\.~-]+)\/(.*)/, serviceHandler);
rest.post(/^\/([a-zA-Z0-9_\.~-]+)\/(.*)/, serviceHandler);
rest.put(/^\/([a-zA-Z0-9_\.~-]+)\/(.*)/, serviceHandler);
rest.del(/^\/([a-zA-Z0-9_\.~-]+)\/(.*)/, serviceHandler);

/**
 * Check resources on this proxy is enough to run one more service of not.
 * This function is called when a new service ready to run.
 * @see firstUtilityCheck
 */
function resourceCheck() {
//	console.log(os.loadavg());
//	console.log(os.totalmem());
//	console.log(os.freemem());
//	console.log(os.cpus());
	return true;
}

/**
 * Check user utility can be satisfy or not before a new service ready to run,
 * otherwise, it should forward the reques.
 */
function firstUtilityCheck(serviceInfo, userPolicies) {
	var utility = {
		responseTime: false,
		dataTransferSize: false,
		resultFidelity: false,
	}
	async.parallel([
		function(callback) {
			var key = userPolicies["responseTime"];
			if( ! key) { return callback(null, false); }
			rdb.get(key, function(err, reply) {
				utility.responseTime = reply;
				callback(err, reply);
			});
		},
		function(callback) {
		    var key = userPolicies["dataTransferSize"];
		    if( ! key) { return callback(null, false); }
		    rdb.get(key, function(err, reply) {
				utility.dataTransferSize = reply;
			    callback(err, reply);
			});
		},
		function(callback) {
		    var key = userPolicies["resultFidelity"];
		    if( ! key) { return callback(null, false); }
			rdb.get(key, function(err, reply) {
		        utility.resultFidelity = reply;
			    callback(err, reply);
			});
		},
	], function(err, results) {
	
	});
console.log(userPolicies);
	if(utility.responseTime === null || utility.dataTransferSize === null
			|| utility.resultFidelity === null) {
		console.log('checked');
	   //還要去下載
		//return false;		
	}

	resourceCheck();
	return true;
}

httpProxy.setMaxSockets(1024);

var server = httpProxy.createServer(//bodyParser(),
		//body parser absorbs the data and end events before passing control to the next
		//// middleware. if we want to proxy it, we'll need to re-emit these events after
		////passing control to the middleware.
//require('./node_modules/http-proxy/examples/node_modules/connect-restreamer')(),
function(req, res, proxy) { // HTTP Proxy
	var query  = url.parse(req.url),
	    buffer = httpProxy.buffer(req),
		key    = query.protocol + "//" + query.host
		userPolicies   = userPolicy.parse(req.headers["user-policy"]);

	// check user preference not to run service locally or not
//	console.log(userPolicies);
	if(userPolicies["no-served"]) {
		proxy.proxyRequest(req, res, {
		    host: query.hostname,
		    port: query.port ||  80,
		    buffer: buffer
		});
		console.log("no served");
		return;
	}

	console.log(key);
	// lookup local services by key which is a domain/host 
	rdb.hkeys(key, function(err, reply) {
		if(reply.length != 0) {
			var service_name = "";
			
			// use the longest match one
			reply.forEach(function(item) {
				var pattern = new RegExp("^"+ regEscape(item) + ".*")
				if(query.path.match(pattern) && (item.length > service_name.length)) {
					service_name = item;
				}
			});

			if(service_name != "") {
				// we know which service to run, look up for service information
				rdb.hget(key, service_name, function(err, reply) {
					if(reply != null) {
						var info = JSON.parse(reply);
						
						// check resources status and user preferences to make
						// sure that user take benefit from running service
						// locally.
						if(firstUtilityCheck(info, userPolicies)) {
							
							// loading local service
							try {
								var service = require(info.module_path);
								service.init({prefix: info.policy.uri, proxy: 'http://127.0.0.1:8000'});
							} catch(err) {
								console.log("Load service error: " + err);
								proxy.proxyRequest(req, res, {
								    host: query.hostname,
									port: query.port ||  80,
								    buffer: buffer
								});
								return;
							}
						
							// leave only service params part of url
							var _req = _.clone(req);
							_req.url = query.path;//req.url.replace(info.policy.base_url, "");
							
							// run local service. if not success, forward the request to remote
							if(!service.route(_req, res)) {
								// set up flag to prevent download module & policy for this response
								res.local_served = true;
								console.log("local served [" + req.url + "]");
								return;
							}
							return;
						}
					} // if reply != null
					proxy.proxyRequest(req, res, {
						host: query.hostname,
						port: query.port ||  80,
						buffer: buffer
					});
					console.log("no match service");
				}); // hget
				return;
			} // if service_name == 0
		} // if reply.length == 0
		proxy.proxyRequest(req, res, {
			host: query.hostname,
			port: query.port ||  80,
			buffer: buffer
		});
		console.log("no match domain");
	}); // hkeys
});

// -- Download Service Module and Policy
// -----------------------------------------------------

var serviceFetchingQueue = async.queue(function(task, callback) {

	var module_tmp_path = moduleTmpPath + new Buffer(task.module_url).toString('base64') + ".tar.gz",
		module_target_path = modulePath + new Buffer(task.module_url).toString('base64');

	request.get(task.module_url, function(err, res, body) {
		console.log(res.headers);
		if(err) {
			console.log(err);
			callback();
		}
	}).pipe(fs.createWriteStream(module_tmp_path)).on("error", function(err) {
		console.log(err);
		callback();
	}).on("close", function() {
		mkdirp(module_target_path, function(err) {
			if( ! err) {
				new targz().extract(module_tmp_path, module_target_path, function(err) {
					if( ! err) {
						request.get(task.policy_url, function(err, res, body) {

							if( ! err) {
								var info = {
									service: task.host.href,
									module_uri: task.module_url,
									module_path: module_target_path + "/package",
									policy_uri: task.policy_url,
									policy: JSON.parse(body),
								};

								var key   = info.policy.base_url,
									field = info.policy.uri;
								rdb.hset(key, field, JSON.stringify(info), function(err, reply) {
									if( ! err) {
										['responseTime', 'dataTransferSize', 'resultFidelity'].forEach(function(url) {
											if(info.policy.typeParameter.hasOwnProperty(url)) {
												request.get(info.policy.typeParameter[url], function(err, res, body) {
													rdb.set("utility:" + info.policy.typeParameter[url], body, function(err, reply) {
														if(err) {
															console.log('fetch utility function ['+url+'] failed');
														}
													});
												});
											}
										});
									} else {
										console.log(err);
									} 
									callback();
								});
							} else {
								console.log(err);
								callback();
							}
						});
					} else {
						console.log("Untar module failed: " + err);
						callback();
					}
				});
			} else {
				console.log("Cann't mkdir: " + err);
				callback();
			}
		});
	});
}, 2);


server.proxy.on("end", function(req, res, response) {
	if(res.lcoal_served) {
		return;
	}

	var linkHeader = res.getHeader("Link"),
		query = url.parse(req.url);

	if(typeof linkHeader != "undefined") {
		var parsed = linkParser(linkHeader);
		if(parsed.module && parsed.module.url  
			&& parsed.policy && parsed.policy.url) {
			serviceFetchingQueue.push({host: query, module_url: parsed.module.url, policy_url: parsed.policy.url});
		}
	}
});

// -- Start Proxying
// ------------------------------------------------------

server.listen(proxyPort);

