const fs = require('fs');
const files = ['queue.js', 'courts.js', 'dashboard.js', 'tv-display.js', 'admin.js'];

files.forEach(file => {
  if(!fs.existsSync(file)) return;
  let code = fs.readFileSync(file, 'utf8');
  
  code = code.replace(/import \{([\s\S]*?)\} from '.\/firebase.js';/g, (match, p1) => {
    if (!p1.includes('getTenantCollection')) p1 += ', getTenantCollection, getTenantDoc';
    return 'import {' + p1 + '} from \'./firebase.js\';';
  });
  code = code.replace(/import \{([\s\S]*?)\} from "\.\/firebase\.js";/g, (match, p1) => {
    if (!p1.includes('getTenantCollection')) p1 += ', getTenantCollection, getTenantDoc';
    return 'import {' + p1 + '} from "./firebase.js";';
  });
  
  code = code.replace(/collection\(db,\s*"([^"]+)"\)/g, 'getTenantCollection("$1")');
  code = code.replace(/collection\(db,\s*'([^']+)'\)/g, "getTenantCollection('$1')");
  
  code = code.replace(/doc\(db,\s*"([^"]+)",\s*([^\)]+)\)/g, 'getTenantDoc("$1", $2)');
  code = code.replace(/doc\(db,\s*'([^']+)',\s*([^\)]+)\)/g, "getTenantDoc('$1', $2)");
  
  code = code.replace(/doc\(getTenantCollection\("([^"]+)"\)\)/g, 'getTenantDoc("$1")');
  code = code.replace(/doc\(getTenantCollection\('([^']+)'\)\)/g, "getTenantDoc('$1')");
  
  fs.writeFileSync(file, code);
});
console.log('Migration complete');
