/** Find the first explicit Windows file path recorded in an insight body. */
export function insightFilePath(body: string): string | null {
  const match =
    /(?:^|[^A-Za-z0-9])((?:[A-Za-z]:[\\/]|\\\\)[^`\r\n<>|"?*]*?\.[A-Za-z0-9]{1,12})(?=$|[\s),.;:'"`\]}])/.exec(body)
  return match?.[1]?.trim() || null
}
