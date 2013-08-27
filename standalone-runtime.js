var cluster = require("cluster"),
	service_runtime = require("./service-runtime.js");

var port = process.argv[2]; // argv[2] is the first argument to this module
if(cluster.isMaster) {
	for(var i = 0; i < 4; ++i) {
		cluster.fork();
	}
} else {
	runtime = service_runtime.createRuntime();
	runtime.listen(port);
}

