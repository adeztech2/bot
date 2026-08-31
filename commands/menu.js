export const name = 'menu'

export const category = 'General'

export const description =
  'Show available commands'

export async function execute({
  reply
}) {
  await reply(
    `╭━━━〔 🤖 BOT 〕━━━╮
┃
┃  📋 COMMAND MENU
┃
┃  .ping
┃  Check if the bot is alive
┃
┃  .menu
┃  Show this menu
┃
╰━━━━━━━━━━━━━━━━━━╯`
  )
}
