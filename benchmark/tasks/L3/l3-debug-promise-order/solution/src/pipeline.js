export async function runPipeline(tasks) {
  return Promise.all(tasks.map((task) => task()));
}
