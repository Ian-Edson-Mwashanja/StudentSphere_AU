require("dotenv").config();
const { Pool } = require("pg");
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing from .env");
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    ca: require("fs").readFileSync(
      require("path").join(__dirname, "prod-ca-2021.crt"),
      "utf8"
    ),
    rejectUnauthorized: true
  },
  options: "-c search_path=studentsphere,public",
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error.message);
});
async function query(text, params = []) {
  return pool.query(text, params);
}
async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
module.exports = {
  pool,
  query,
  transaction
};



