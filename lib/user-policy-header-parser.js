/**
 * HTTP User Policy Header Parser
 */

module.exports.parse = function(str) {
	if(typeof str !== "string") {
		return {};
	}

	var parsed = {},
		comma = str.split(",");
	
	comma.forEach(function(item) {
		var pair  = item.split("="),
			key, value;

		switch(pair.length) {
			case 2:
				key   = pair[0].replace(/^\s+|\s+$/g, ""),
				value = pair[1].replace(/^\s+|\s+$/g, "").replace(/^"|"$/g, "");
				break;
			case 1:
				key   = pair[0].replace(/^\s+|\s+$/g, "");
				value = true;
				break;
			case 0:
				return;
		}
		
		parsed[key] = value;
	})

	return parsed;
}
