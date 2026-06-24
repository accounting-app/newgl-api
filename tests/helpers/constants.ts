import { resolve } from "node:path";
// const BEANCOUNT_STANDARD_FIXTURE = "beancount-standard.bean";
export const BEANCOUNT_STANDARD_FIXTURE = resolve(import.meta.dir, "../../data/beancount_standard.bean");

// ENOENT: no such file or directory, open '/Users/myrmidon/code/simpleaccounting/newgl/api/tests/data/beancount-standard.bean'
//     path: "/Users/myrmidon/code/simpleaccounting/newgl/api/tests/data/beancount-standard.bean",