var service_runtime = require("./service-runtime.js"),
	runtime = service_runtime.createRuntime();

runtime.listen(process.argv[2]); // argv[2] is the first argument to this module

