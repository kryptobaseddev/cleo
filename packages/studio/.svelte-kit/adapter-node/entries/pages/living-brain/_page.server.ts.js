import { t as getAllSubstrates } from "../../../chunks/adapters.js";
//#region src/routes/living-brain/+page.server.ts
/**
* Living Brain page server load.
*
* Fetches the initial graph from the unified Living Brain API with a
* default limit of 500 nodes.  The client-side component can request
* larger slices via the "Full graph" button.
*/
var load = () => {
	return { graph: getAllSubstrates({ limit: 500 }) };
};
//#endregion
export { load };
