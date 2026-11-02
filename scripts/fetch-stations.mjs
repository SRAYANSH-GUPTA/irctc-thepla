import {StationCatalog} from '../app/stations.mjs';
try {console.log(JSON.stringify(await new StationCatalog().refresh()));}
catch(e){console.error(e.message);process.exitCode=1;}
