var	url        = require('url'),
	linkParser = require('parse-link-header'),
	redis      = require('redis'),
	async      = require('async'),
	fs         = require('fs'),
	request    = require('request'),
	targz      = require('tar.gz'),
	mkdirp     = require('mkdirp')
	_          = require('underscore');

var	moduleTmpPath = process.argv[2],
	modulePath    = process.argv[3]; // passed by main parent process

var rdb = redis.createClient();

rdb.on("ready", function(err) {
	if(err) {
		console.log("[Error] Can't connect to Redis: " + err);
		return;
	}
});

// -- Download Service Module, Policy, Utility Function
// -----------------------------------------------------
// When receiving a non-local served response, trying to fetch
// service module, service policy and utility functions specified
// in this pollicy by checking link header in response.
// -----------------------------------------------------

var serviceFetchingQueue = async.queue(function(task, callback) {

	// assumming that all service modules are in node.js module package format compressed by tar.gz in this implemenetation
	var module_tmp_path = moduleTmpPath + new Buffer(task.module_url).toString('base64') + ".tar.gz",
		module_target_path = modulePath + new Buffer(task.module_url).toString('base64');

	// Fetch service module first
	request.get(task.module_url, function(err, res, body) {

		if(err || res.statusCode != 200) {
			console.log("[Error] Can't fetch service module: " + (err || res.statusCode));
			callback();
		}
	}).pipe(fs.createWriteStream(module_tmp_path)).on("error", function(err) {
		console.log("[Error] Create tmp service module file failed: " + err);
		callback();
	}).on("close", function() { // all data wrotten

		// create directory to contain unpacked service module 
		mkdirp(module_target_path, function(err) {
			if(err) {
				console.log("[Error] Can't create directory: " + err);
				callback();
				return;
			}
			
			// untar module
			new targz().extract(module_tmp_path, module_target_path, function(err) {
				if(err) {
					console.log("[Error] Untar module failed: " + err);
					callback();
					return;
				}

				// module is OK now, start to fetch service policy
				request.get(task.policy_url, function(err, res, body) {
					if(err) {
						console.log("[Error] Fail to fetch policy: " + err);
						callback();
						return;
					}
					
					// We got service module & service policy, store them first
					var info = {
						service: task.host.href,
						module_uri: task.module_url,
						module_path: module_target_path + "/package",
						policy_uri: task.policy_url,
						policy: JSON.parse(body),
					};

					var key   = "service:" + info.policy.base_url + info.policy.uri;
					rdb.set(key, JSON.stringify(info), function(err, reply) {
						if(err) {
							console.log("[Error] Fail to store policy: " + err);
							callback();
							return;
						}

						// Do next task directly, without waiting tasks of utility functions.
						console.log("[Info] Caching new service module & policy [" + key + "]");
						callback();
					});
				});
			});
		});
	});
}, 2); // 2 concurrent 

function getModule(opt) {
	var linkHeader = opt.linkHeader,
		query = url.parse(opt.url);

	if(typeof linkHeader != "undefined") {
		var parsed = linkParser(linkHeader);
		if(parsed.module && parsed.module.url && parsed.policy && parsed.policy.url) {
			// create a new task into a queue and schedule to download
			serviceFetchingQueue.push({
				host: query, 
				module_url: parsed.module.url, 
				policy_url: parsed.policy.url
			});
		}
	}
};

// -- Download Utility Function
// ------------------------------------------------------
// Fetch utility from the url, and storing it to redis
// ------------------------------------------------------
var utilityFetchingQueue = async.queue(function(task, callback) {
	request.get(task.url, function(err, res, body) {
		if(err || res.statusCode != 200) {
			console.log("[Error] Fail to fetch utility: " + (err || res.statusCode));
			callback();
	    	return;
	    }

	    rdb.set("utility:" + task.url, body.replace(/^"|"$/g, ""), function(err, reply) {
			if(err) {
				console.log('[Error] Fail to store utility function: ' + err);
	        }
	        callback();
		});
	});
}, 2); // 2 concurrent

function getUtility(opt) {
	utilityFetchingQueue.push({
		url: opt.url,
	});
}

// -- Waiting for notification
// ----------------------------------------------------
// This standalone fetcher is an V8 instance which will
// not exit automaticly, but waiting for event. We listen
// on "message" event to do the job.
// ---------------------------------------------------
process.on("message", function(msg) {
	switch(msg.type) {
		case "module":
			getModule(msg.opt);
			break;
		case "utility":
			getUtility(msg.opt);
			break;
	}
});

/* End of file standalone-fetcher.js */
