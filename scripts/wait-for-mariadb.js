#!/usr/bin/env node

const mysql = require('mysql2/promise');

const url = process.env.MARIADB_TEST_URL || 'mysql://xsd:xsdpass@127.0.0.1:3307/xsd_to_ir_test';
const attempts = Number(process.env.MARIADB_WAIT_ATTEMPTS || 60);
const delayMs = Number(process.env.MARIADB_WAIT_DELAY_MS || 1000);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function probe() {
  const conn = await mysql.createConnection(url);
  try {
    await conn.query('SELECT 1');
  } finally {
    await conn.end();
  }
}

async function main() {
  let lastError;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await probe();
      console.log(`MariaDB ready after ${i} attempt(s)`);
      return;
    } catch (err) {
      lastError = err;
      await sleep(delayMs);
    }
  }

  throw new Error(`MariaDB did not become ready: ${lastError ? lastError.message : 'no response'}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
