/**
 * HTTP User Policy Header Parser
 */

var _ = require("underscore");

var _default = {
	responseTime: "default",
	dataTransferSize: "default",
	t: 0,
	d: 0
};

module.exports.parse = function(str) {
	if(typeof str !== "string") {
		return _default;
	}

	var parsed = _.clone(_default),
		comma = str.split(",");
	
	comma.forEach(function(item) {
		var pair  = item.split("="),
			key, value;

		switch(pair.length) {
			case 2:
				key   = pair[0].replace(/^\s+|\s+$/g, ""),
				value = pair[1].replace(/^\s+|\s+$/g, "").replace(/^["']|["']$/g, "");
				break;
			case 1:
				var _key = pair[0].replace(/^\s+|\s+$/g, "");
				if(_key) {
					key   = _key;
					value = true;
					break;
				}
				return;
			case 0:
				return;
		}
		
		parsed[key] = value;
	})

	return parsed;
}

module.exports.stringify = function(obj) {
	if(typeof obj != "object") {
		return "";
	}

	var str = "";

	for(var attr in obj) {
		if(obj.hasOwnProperty(attr)) {
			if(obj[attr] === true) {
				str += ("" + attr + ",");
			} else {
				str += ("" + attr + "=\"" + obj[attr] + "\",");
			}
		}
	}

	return str;
}

/* End of file user-policy-header-parser.js */
