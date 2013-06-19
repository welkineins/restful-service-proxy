var httpProxy = require('http-proxy'),
	http      = require('http'),
	url       = require('url'),
	linkParser= require('parse-link-header'),
	redis     = require('redis'),
	async     = require('async'),
	fs        = require('fs'),
	crypto    = require('crypto');

var proxyPort = 8000;
var modulePath = "./public/modules/"; 

var rdb = redis.createClient();


rdb.on("on", function(err) {
	console.log("Error: " + err);
});

httpProxy.setMaxSockets(1024);
var server = httpProxy.createServer(function(req, res, proxy) { // HTTP Proxy
	var query = url.parse(req.url);
	var buffer = httpProxy.buffer(req);
	console.log(query);

	// Start routing.
	// - 
	rdb.get(query.href, function(err, reply) {
		if(reply === null) {
			proxy.proxyRequest(req, res, {
				host: query.hostname,
				port: query.port ||  80,
				buffer: buffer
			});
		} else {
			res.writeHead(200, {'Content-Type': 'text/plain'});
			res.end(reply);
			console.log("hahaha");
		}
	});


var serviceFetchingQueue = async.queue(function(task, callback) {
	var pattern = new RegExp("/^http/");
	var uri = task.uri;
	if( ! pattern.test(task.uri)) {
		uri = task.host.protocol + "//" + task.host.host + "/" + task.uri;
	}
	http.get(uri, function(res) {
		var buffer = "";

		res.on("data", function(chunk) {
			buffer += chunk;
		});

		res.on("end", function() {
			if(task.type == "module") {
				fs.writeFile(new Buffer(modulePath + uri).toString('base64'), buffer, 'binary', function(err) {
					if(err) {
						console.log(err);
						console.log("Write module [" + task.uri + "] failed.");
					}
					callback();
				});
			} else { // pocliy
				rdb.set(task.host.href, buffer, function(err, reply) {
					
				});
			}
		});
	}).on("error", function(err) {
		console.log("Get [" + uri + "] failed.");
		callback();
	});
}, 2);

server.proxy.on("end", function(req, res, response) {
	var linkHeader = res.getHeader("Link");
	var query = url.parse(req.url);
	if(typeof linkHeader != "undefined") {
		var parsed = linkParser(linkHeader);
		if(typeof parsed.module.url != "undefined" && 
			typeof parsed.policy.url != "undefined") {
			serviceFetchingQueue.push({host: query, uri: parsed.module.url, type:"module"});
			serviceFetchingQueue.push({host: query, uri: parsed.policy.url, type:"profile"});
		}
	}
});

}).listen(proxyPort);
