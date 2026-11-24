// Runs `work(client)` in one transaction on a pooled client, rolling back on any error.
export async function transaction(pool, work, begin = 'BEGIN') {
  const client = await pool.connect();
  let broken;
  try {
    await client.query(begin);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError) => { broken = rollbackError; });
    throw error;
  } finally {
    client.release(broken);
  }
}
