import 'dotenv/config'

import express from 'express'
import http from 'http'
import { Server as SocketIOServer } from 'socket.io'
import fs from 'fs'
import path from 'path'
import AdmZip from 'adm-zip'
import QRCode from 'qrcode'
import pino from 'pino'
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'
import { createClient } from '@supabase/supabase-js'

import {
  loadCommands,
  loadObservers,
  handleMessage,
  getAllCommands
} from './lib/router.js'

const __dirname = path.resolve()

const PORT = Number(process.env.PORT || 3000)
const OWNER_NUMBER = String(process.env.OWNER_NUMBER || '254111783552')
const PREFIX = process.env.PREFIX || '.'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ SUPABASE_URL or SUPABASE_ANON_KEY is missing.')
  process.exit(1)
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
)

const app = express()
const server = http.createServer(app)
const io = new SocketIOServer(server)

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(express.static(path.join(__dirname, 'public')))

let sock = null
let reconnecting = false
let isConnecting = false

let lastSessionSync = 0
const SESSION_SYNC_INTERVAL = 2 * 60 * 1000

const sessionDir = path.join(__dirname, 'session')

if (!fs.existsSync(sessionDir)) {
  fs.mkdirSync(sessionDir, { recursive: true })
}

/*
|--------------------------------------------------------------------------
| Health endpoint
|--------------------------------------------------------------------------
*/

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    bot: 'Bot',
    whatsapp: Boolean(sock),
    uptime: process.uptime(),
    commands: getAllCommands().length,
    timestamp: new Date().toISOString()
  })
})

/*
|--------------------------------------------------------------------------
| Pair page
|--------------------------------------------------------------------------
*/

app.get('/pair.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pair.html'))
})

/*
|--------------------------------------------------------------------------
| Session ZIP
|--------------------------------------------------------------------------
*/

function zipSession() {
  const zip = new AdmZip()

  if (!fs.existsSync(sessionDir)) {
    return null
  }

  const files = fs.readdirSync(sessionDir)

  if (files.length === 0) {
    return null
  }

  zip.addLocalFolder(sessionDir)

  return zip.toBuffer()
}

async function saveSessionToSupabase(force = false) {
  try {
    const now = Date.now()

    if (
      !force &&
      now - lastSessionSync < SESSION_SYNC_INTERVAL
    ) {
      return
    }

    const zipBuffer = zipSession()

    if (!zipBuffer) {
      return
    }

    const data = zipBuffer.toString('base64')

    const { error } = await supabase
      .from('bu_sessions')
      .upsert(
        {
          id: 'main',
          data
        },
        {
          onConflict: 'id'
        }
      )

    if (error) {
      console.error('❌ Supabase session save failed:')
      console.error(error)
      return
    }

    lastSessionSync = now

    console.log('✅ WhatsApp session synced to Supabase')
  } catch (error) {
    console.error('❌ Session sync error:')
    console.error(error.stack || error)
  }
}

/*
|--------------------------------------------------------------------------
| Restore session from Supabase
|--------------------------------------------------------------------------
*/

async function restoreSessionFromSupabase() {
  try {
    const { data, error } = await supabase
      .from('bu_sessions')
      .select('data')
      .eq('id', 'main')
      .maybeSingle()

    if (error) {
      console.error('❌ Could not read Supabase session:')
      console.error(error)
      return
    }

    if (!data?.data) {
      console.log('ℹ️ No saved WhatsApp session found.')
      return
    }

    const zipBuffer = Buffer.from(data.data, 'base64')

    const zip = new AdmZip(zipBuffer)

    zip.extractAllTo(sessionDir, true)

    console.log('✅ WhatsApp session restored from Supabase')
  } catch (error) {
    console.error('❌ Session restore failed:')
    console.error(error.stack || error)
  }
}

/*
|--------------------------------------------------------------------------
| Number formatting
|--------------------------------------------------------------------------
*/

function normalizeNumber(number) {
  return String(number)
    .replace(/\D/g, '')
    .replace(/^0+/, '')
}

function ownerJid() {
  return `${normalizeNumber(OWNER_NUMBER)}@s.whatsapp.net`
}

/*
|--------------------------------------------------------------------------
| Send owner connection message
|--------------------------------------------------------------------------
*/

async function sendOwnerConnectedMessage() {
  try {
    if (!sock) return

    const jid = ownerJid()

    await sock.sendMessage(jid, {
      text:
        '✅ *Bot Connected Successfully!*\n\n' +
        '🤖 Bot: Bot\n' +
        `🔹 Prefix: ${PREFIX}\n` +
        `🔹 Commands: ${getAllCommands().length}\n` +
        '🔹 Session: Supabase synced\n\n' +
        'Send *.menu* to see available commands.'
    })

    console.log('✅ Owner confirmation message sent')
  } catch (error) {
    console.error('❌ Could not send owner message:')
    console.error(error.stack || error)
  }
}

/*
|--------------------------------------------------------------------------
| Socket.IO
|--------------------------------------------------------------------------
*/

io.on('connection', socket => {
  console.log('🌐 Pair page connected:', socket.id)

  socket.emit('status', {
    connected: Boolean(sock)
  })

  socket.on('request-pair-code', async number => {
    try {
      if (!sock) {
        socket.emit('pair-error', 'WhatsApp is not ready yet.')
        return
      }

      const phone = normalizeNumber(number)

      if (!phone) {
        socket.emit('pair-error', 'Enter a valid WhatsApp number.')
        return
      }

      console.log(`📱 Pair code requested for: ${phone}`)

      const code = await sock.requestPairingCode(phone)

      socket.emit('pair-code', {
        code
      })

      console.log('✅ Pairing code generated:', code)
    } catch (error) {
      console.error('❌ Pair code error:')
      console.error(error.stack || error)

      socket.emit(
        'pair-error',
        error.message || 'Could not generate pairing code.'
      )
    }
  })
})

/*
|--------------------------------------------------------------------------
| Start WhatsApp
|--------------------------------------------------------------------------
*/

async function startBot() {
  if (isConnecting) {
    return
  }

  isConnecting = true
  reconnecting = false

  try {
    await restoreSessionFromSupabase()

    const { state, saveCreds } =
      await useMultiFileAuthState(sessionDir)

    let version

    try {
      const latest = await fetchLatestBaileysVersion()
      version = latest.version

      console.log(
        `📦 Baileys compatible version: ${version.join('.')}`
      )
    } catch {
      console.log(
        '⚠️ Could not fetch WhatsApp version. Using Baileys default.'
      )
    }

    sock = makeWASocket({
      auth: state,

      ...(version ? { version } : {}),

      logger: pino({
        level: 'silent'
      }),

      printQRInTerminal: false,

      browser: [
        'Bot',
        'Chrome',
        '20.11.1'
      ],

      syncFullHistory: false,

      fireInitQueries: false,

      markOnlineOnConnect: false,

      generateHighQualityLinkPreview: false
    })

    /*
    |--------------------------------------------------------------------------
    | Credentials updated
    |--------------------------------------------------------------------------
    */

    sock.ev.on('creds.update', async () => {
      await saveCreds()

      await saveSessionToSupabase(false)
    })

    /*
    |--------------------------------------------------------------------------
    | Connection updates
    |--------------------------------------------------------------------------
    */

    sock.ev.on('connection.update', async update => {
      const {
        connection,
        lastDisconnect,
        qr
      } = update

      if (qr) {
        console.log('📲 QR code generated')

        try {
          const qrData = await QRCode.toDataURL(qr)

          io.emit('qr', {
            qr: qrData
          })
        } catch (error) {
          console.error('❌ QR generation failed:')
          console.error(error.stack || error)
        }
      }

      if (connection === 'connecting') {
        console.log('🔄 Connecting to WhatsApp...')

        io.emit('status', {
          connected: false,
          connecting: true
        })
      }

      if (connection === 'open') {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━')
        console.log('✅ BOT CONNECTED')
        console.log('🤖 Bot')
        console.log(`👤 Owner: +${OWNER_NUMBER}`)
        console.log(`🔹 Prefix: ${PREFIX}`)
        console.log(`📦 Commands: ${getAllCommands().length}`)
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━')

        io.emit('status', {
          connected: true,
          connecting: false
        })

        await saveSessionToSupabase(true)

        await sendOwnerConnectedMessage()
      }

      if (connection === 'close') {
        sock = null

        io.emit('status', {
          connected: false,
          connecting: false
        })

        const error =
          lastDisconnect?.error

        const message =
          error?.message ||
          String(error || '')

        console.error(
          '❌ WhatsApp connection closed:',
          message
        )

        /*
        |--------------------------------------------------------------------------
        | Conflict protection
        |--------------------------------------------------------------------------
        */

        if (
          message.toLowerCase().includes('conflict')
        ) {
          console.error(
            '🚨 STREAM ERRORED CONFLICT DETECTED.'
          )

          console.error(
            '🚨 Another copy of this bot is probably running.'
          )

          console.error(
            '🚨 Stopping this process to prevent duplicate sessions.'
          )

          process.exit(1)
        }

        const statusCode =
          error?.output?.statusCode

        if (
          statusCode ===
          DisconnectReason.loggedOut
        ) {
          console.error(
            '🚪 WhatsApp logged out.'
          )

          console.error(
            'Delete the Supabase bu_sessions row and pair again.'
          )

          process.exit(1)
        }

        if (!reconnecting) {
          reconnecting = true

          console.log(
            '🔄 Reconnecting in 5 seconds...'
          )

          setTimeout(() => {
            isConnecting = false
            startBot()
          }, 5000)
        }
      }
    })

    /*
    |--------------------------------------------------------------------------
    | Incoming messages
    |--------------------------------------------------------------------------
    */

    sock.ev.on('messages.upsert', async update => {
      try {
        if (update.type !== 'notify') {
          return
        }

        for (const message of update.messages) {
          await handleMessage(
            sock,
            message
          )
        }
      } catch (error) {
        console.error(
          '❌ Message processing error:'
        )

        console.error(
          error.stack || error
        )
      }
    })

    /*
    |--------------------------------------------------------------------------
    | Group metadata updates
    |--------------------------------------------------------------------------
    */

    sock.ev.on(
      'groups.update',
      async updates => {
        for (const update of updates) {
          console.log(
            '👥 Group updated:',
            update.id
          )
        }
      }
    )

  } catch (error) {
    console.error(
      '❌ Failed to start WhatsApp:'
    )

    console.error(
      error.stack || error
    )

    sock = null
    isConnecting = false

    setTimeout(
      startBot,
      5000
    )
  }
}

/*
|--------------------------------------------------------------------------
| Load commands and observers
|--------------------------------------------------------------------------
*/

async function initialize() {
  console.log('🚀 Starting Bot...')

  console.log('📂 Loading commands...')

  await loadCommands()

  console.log('👀 Loading observers...')

  await loadObservers()

  console.log(
    `✅ Loaded ${getAllCommands().length} commands`
  )

  server.listen(
    PORT,
    '0.0.0.0',
    () => {
      console.log(
        `🌐 Server running on port ${PORT}`
      )

      console.log(
        `🌐 Pair page: /pair.html`
      )
    }
  )

  await startBot()
}

initialize().catch(error => {
  console.error(
    '❌ Fatal startup error:'
  )

  console.error(
    error.stack || error
  )

  process.exit(1)
})

/*
|--------------------------------------------------------------------------
| Graceful shutdown
|--------------------------------------------------------------------------
*/

async function shutdown(signal) {
  console.log(
    `🛑 ${signal} received. Shutting down...`
  )

  try {
    await saveSessionToSupabase(true)
  } catch {}

  try {
    if (sock) {
      sock.end(undefined)
    }
  } catch {}

  server.close(() => {
    process.exit(0)
  })

  setTimeout(() => {
    process.exit(0)
  }, 5000)
}

process.on(
  'SIGINT',
  () => shutdown('SIGINT')
)

process.on(
  'SIGTERM',
  () => shutdown('SIGTERM')
)
