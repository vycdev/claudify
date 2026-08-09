const outputSize = Number(process.env.CLAUDIFY_LARGE_OUTPUT_SIZE || 70_000);
const output = "x".repeat(outputSize) + "TAIL";
const errorOutput = "e".repeat(outputSize) + "ERROR_TAIL";
process.stdout.write(output);
process.stderr.write(errorOutput);
