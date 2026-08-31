import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'

const __dirname = path.resolve()

const commands = new Map()
const observers = []

/*
|--------------------------------------------------------------------------
| Prefix
|--------------------------------------------------------------------------
*/

const PREFIX = process.env.PREFIX || '.'

/*
|--------------------------------------------------------------------------
| Get all commands
|--------------------------------------------------------------------------
*/

export function getAllCommands() {
  return Array.from(commands.values())
}

/*
|--------------------------------------------------------------------------
| Find JavaScript files recursively
|--------------------------------------------------------------------------
*/

function findJavaScriptFiles(directory) {
  const results = []

  if (!fs.existsSync(directory)) {
    return results
  }

  const entries = fs.readdirSync(
    directory,
    {
      withFileTypes: true
    }
  )

  for (const entry of entries) {
    const fullPath = path.join(
      directory,
      entry.name
    )

    if (entry.isDirectory()) {
      results.push(
        ...findJavaScriptFiles(fullPath)
      )
    }

    if (
      entry.isFile() &&
      entry.name.endsWith('.js')
    ) {
      results.push(fullPath)
    }
  }

  return results
}

/*
|--------------------------------------------------------------------------
| Load commands
|--------------------------------------------------------------------------
*/

export async function loadCommands() {
  const commandDirectory =
    path.join(
      __dirname,
      'commands'
    )

  const files =
    findJavaScriptFiles(
      commandDirectory
    )

  for (const file of files) {
    try {
      /*
      |--------------------------------------------------------------------------
      | pathToFileURL is important for Linux/Render
      |--------------------------------------------------------------------------
      */

      const module =
        await import(
          pathToFileURL(file).href
        )

      const name =
        String(module.name || '')
          .trim()
          .toLowerCase()

      if (!name) {
        console.warn(
          `⚠️ SKIPPED ${path.basename(file)}: missing export const name`
        )

        continue
      }

      if (
        typeof module.execute !==
        'function'
      ) {
        console.warn(
          `⚠️ SKIPPED ${path.basename(file)}: missing execute function`
        )

        continue
      }

      /*
      |--------------------------------------------------------------------------
      | Duplicate command protection
      |--------------------------------------------------------------------------
      */

      if (commands.has(name)) {
        console.warn(
          `⚠️ DUPLICATE COMMAND: ${name} in ${path.basename(file)} — skipped`
        )

        continue
      }

      const command = {
        name,
        category:
          module.category ||
          'General',
        description:
          module.description ||
          'No description',
        execute:
          module.execute,
        file
      }

      commands.set(
        name,
        command
      )

      console.log(
        `✅ Loaded: ${name} [${command.category}]`
      )

    } catch (error) {
      console.error(
        `❌ FAILED ${path.basename(file)}:`
      )

      console.error(
        error.stack || error
      )
    }
  }
}

/*
|--------------------------------------------------------------------------
| Observer loader
|--------------------------------------------------------------------------
*/

export async function loadObservers() {
  const observerDirectory =
    path.join(
      __dirname,
      'observers'
    )

  const files =
    findJavaScriptFiles(
      observerDirectory
    )

  for (const file of files) {
    try {
      const module =
        await import(
          pathToFileURL(file).href
        )

      const observe =
        module.observe ||
        module.default

      if (
        typeof observe !==
        'function'
      ) {
        console.warn(
          `⚠️ SKIPPED OBSERVER ${path.basename(file)}: no observe function`
        )

        continue
      }

      observers.push({
        observe,
        file
      })

      console.log(
        `👀 Loaded observer: ${path.basename(file)}`
      )

    } catch (error) {
      console.error(
        `❌ FAILED OBSERVER ${path.basename(file)}:`
      )

      console.error(
        error.stack || error
      )
    }
  }
}

/*
|--------------------------------------------------------------------------
| LID → JID resolver
|--------------------------------------------------------------------------
*/

export async function resolveLidToJid(
  sock,
  jid
) {
  try {
    if (
      !jid ||
      !jid.endsWith('@lid')
    ) {
      return jid
    }

    /*
    |--------------------------------------------------------------------------
    | Baileys may provide LID mappings through its store/state.
    |--------------------------------------------------------------------------
    */

    if (
      sock?.signalRepository?.lidMapping
    ) {
      const mapping =
        sock.signalRepository.lidMapping

      if (
        mapping &&
        typeof mapping.getPNForLID ===
          'function'
      ) {
        const result =
          await mapping.getPNForLID(
            jid
          )

        if (result) {
          return result
        }
      }
    }

    /*
    |--------------------------------------------------------------------------
    | Basic fallback.
    |--------------------------------------------------------------------------
    */

    return jid.replace(
      '@lid',
      '@s.whatsapp.net'
    )

  } catch (error) {
    console.error(
      '❌ LID resolver error:'
    )

    console.error(
      error.stack || error
    )

    return jid
  }
}

/*
|--------------------------------------------------------------------------
| Admin information
|--------------------------------------------------------------------------
*/

export async function getGroupInfo(
  sock,
  jid,
  sender
) {
  const result = {
    isGroup: false,
    isAdmin: false,
    isBotAdmin: false,
    groupMetadata: null
  }

  if (
    !jid ||
    !jid.endsWith('@g.us')
  ) {
    return result
  }

  result.isGroup = true

  try {
    const groupMetadata =
      await sock.groupMetadata(jid)

    result.groupMetadata =
      groupMetadata

    const participants =
      groupMetadata.participants || []

    const botJid =
      sock.user?.id?.split(':')[0] +
      '@s.whatsapp.net'

    const resolvedSender =
      await resolveLidToJid(
        sock,
        sender
      )

    const resolvedBot =
      await resolveLidToJid(
        sock,
        botJid
      )

    const senderParticipant =
      participants.find(
        participant =>
          participant.id ===
            resolvedSender ||
          participant.jid ===
            resolvedSender ||
          participant.lid ===
            sender
      )

    const botParticipant =
      participants.find(
        participant =>
          participant.id ===
            resolvedBot ||
          participant.jid ===
            resolvedBot ||
          participant.lid ===
            sock.user?.id
      )

    result.isAdmin =
      Boolean(
        senderParticipant?.admin
      )

    result.isBotAdmin =
      Boolean(
        botParticipant?.admin
      )

  } catch (error) {
    console.error(
      `❌ Group metadata failed for ${jid}:`
    )

    console.error(
      error.stack || error
    )
  }

  return result
}

/*
|--------------------------------------------------------------------------
| Extract message text
|--------------------------------------------------------------------------
*/

function getMessageText(message) {
  const content =
    message?.message

  if (!content) {
    return ''
  }

  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    ''
  )
}

/*
|--------------------------------------------------------------------------
| Main message handler
|--------------------------------------------------------------------------
*/

export async function handleMessage(
  sock,
  message
) {
  try {
    if (!message?.message) {
      return
    }

    if (
      message.key?.fromMe
    ) {
      return
    }

    const jid =
      message.key?.remoteJid

    if (!jid) {
      return
    }

    const sender =
      message.key?.participant ||
      jid

    const text =
      getMessageText(message)
        .trim()

    /*
    |--------------------------------------------------------------------------
    | Run observers first
    |--------------------------------------------------------------------------
    */

    for (const observer of observers) {
      try {
        await observer.observe(
          {
            sock,
            message,
            jid,
            sender,
            text,
            prefix: PREFIX
          }
        )
      } catch (error) {
        console.error(
          `❌ FAILED OBSERVER ${path.basename(observer.file)}:`
        )

        console.error(
          error.stack || error
        )
      }
    }

    /*
    |--------------------------------------------------------------------------
    | Ignore non-command messages
    |--------------------------------------------------------------------------
    */

    if (
      !text.startsWith(PREFIX)
    ) {
      return
    }

    const withoutPrefix =
      text.slice(
        PREFIX.length
      ).trim()

    if (!withoutPrefix) {
      return
    }

    const parts =
      withoutPrefix.split(
        /\s+/
      )

    const commandName =
      parts.shift()
        .toLowerCase()

    const args = parts

    const command =
      commands.get(commandName)

    if (!command) {
      return
    }

    /*
    |--------------------------------------------------------------------------
    | Group/admin information
    |--------------------------------------------------------------------------
    */

    const groupInfo =
      await getGroupInfo(
        sock,
        jid,
        sender
      )

    /*
    |--------------------------------------------------------------------------
    | Command context
    |--------------------------------------------------------------------------
    */

    const context = {
      sock,
      message,
      jid,
      sender,
      text,
      args,
      command: commandName,
      prefix: PREFIX,

      isGroup:
        groupInfo.isGroup,

      isAdmin:
        groupInfo.isAdmin,

      isBotAdmin:
        groupInfo.isBotAdmin,

      groupMetadata:
        groupInfo.groupMetadata,

      resolveLidToJid:
        target =>
          resolveLidToJid(
            sock,
            target
          ),

      reply: async text => {
        return sock.sendMessage(
          jid,
          {
            text
          },
          {
            quoted: message
          }
        )
      }
    }

    /*
    |--------------------------------------------------------------------------
    | Execute command
    |--------------------------------------------------------------------------
    */

    try {
      await command.execute(
        context
      )

    } catch (error) {
      console.error(
        `❌ FAILED ${path.basename(command.file)}:`
      )

      console.error(
        error.stack || error
      )

      try {
        await context.reply(
          '❌ An error occurred while running this command.'
        )
      } catch {}
    }

  } catch (error) {
    console.error(
      '❌ Message handler failed:'
    )

    console.error(
      error.stack || error
    )
  }
  }
