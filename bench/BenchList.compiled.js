/**
 * Compiled component: BenchList
 * Hand-crafted for benchmarking (matches compiler output format)
 *
 * Structure:
 *   :if="items.length > 0"
 *     <ul>
 *       :for="item in items"
 *         <li @click="removeItem(index)"><span>{{ item }}</span></li>
 */

const compiled = {
	template: '<div><!--if--></div>',

	binding: {
		strings: [],
		code: new Uint16Array([])
	},

	eval: [],

	event: [],

	dynamics: [
		{
			type: 'if',
			markerIndex: 0,
			markerPath: [0],
			chain: [
				{
					condition: "items.length > 0",
					template: '<ul><!--for--></ul>',
					binding: { strings: ["items"], code: new Uint16Array([]) },
					eval: [],
					event: [],
					dynamics: [
						{
							type: 'for',
							markerIndex: 0,
							markerPath: [0],
							source: "items",
							iterator: "item",
							template: '<li><span>\u200B</span></li>',
							binding: {
								strings: ["click", "removeItem", "index", "item"],
								code: new Uint16Array([
									// EVENT on root <li>: type=6, pathLen=0, data=[0,1]
									6, 0, 0, 1,
									// TEXT on <span> (path [0]): type=1, pathLen=1, path=[0], propIdx=3("item")
									1, 1, 0, 3
								])
							},
							eval: [],
							event: [
								["click", "removeItem", "index"]
							],
							dynamics: []
						}
					]
				}
			]
		}
	],
};

compiled.data = () => ({
	items: []
});

compiled.method = {
	removeItem(index) {
		this.items.splice(index, 1);
	}
};

export default compiled;
