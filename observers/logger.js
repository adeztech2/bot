export async function observe({
  jid,
  text
}) {
  if (!text) return

  console.log(
    `💬 Message from ${jid}: ${text}`
  )
}
