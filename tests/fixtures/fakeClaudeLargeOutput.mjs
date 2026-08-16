const outputSize = Number(process.env.CLAUDIFY_LARGE_OUTPUT_SIZE || 70_000);
const unicodeBoundary =
    process.env.CLAUDIFY_LARGE_OUTPUT_UNICODE_BOUNDARY === "1";
const output = unicodeBoundary
    ? `x😀${"x".repeat(outputSize - 5)}TAIL`
    : `${"x".repeat(outputSize)}TAIL`;
const errorOutput = unicodeBoundary
    ? `e😀${"e".repeat(outputSize - 11)}ERROR_TAIL`
    : `${"e".repeat(outputSize)}ERROR_TAIL`;
process.stdout.write(output);
process.stderr.write(errorOutput);
