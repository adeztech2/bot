export const name = 'ping'

export const category = 'General'

export const description =
  'Check if the bot is alive'

export async function execute({
  reply
}) {
  await reply(
    '🏓 Pong!\n\n✅ Bot is working.'
  )
}
