import * as fs from "fs";
import * as path from "path";

const projectRoot = process.cwd();

export const TX_CREATE_FOOTOKEN_HTLC = fs.readFileSync(
  path.resolve(
    projectRoot,
    "../flow/FooToken/cadence/transactions/create_footoken_htlc.cdc"
  ),
  "utf8"
);

export const TX_UNLOCK_FOOTOKEN_HTLC = fs.readFileSync(
  path.resolve(
    projectRoot,
    "../flow/FooToken/cadence/transactions/unlock_footoken_htlc.cdc"
  ),
  "utf8"
);
