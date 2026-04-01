/**
 * mailer.js – Invia l'Excel via email
 *
 * Supporta due provider:
 * A) Gmail App Password (funziona solo da IP residenziali)
 *    1. Abilita 2FA su Google Account
 *    2. myaccount.google.com/apppasswords → crea App Password "Mail"
 *    3. Imposta gmail_user + gmail_app_password nelle impostazioni
 *
 * B) SMTP custom (es. Brevo – funziona da server/VPS)
 *    1. Crea account su brevo.com (free: 300 email/giorno)
 *    2. SMTP & API → SMTP → genera SMTP key
 *    3. Imposta smtp_host=smtp-relay.brevo.com, smtp_port=587,
 *       smtp_user=tuaemail@esempio.com, smtp_pass=<chiave SMTP>
 *    Se smtp_host è impostato, viene usato al posto di Gmail.
 */

const nodemailer = require('nodemailer')
const path = require('path')
const fs = require('fs')

function buildTransport(s) {
  if (s.smtpHost) {
    return nodemailer.createTransport({
      host: s.smtpHost,
      port: parseInt(s.smtpPort) || 587,
      secure: false,
      auth: { user: s.smtpUser, pass: s.smtpPass },
    })
  }
  // Fallback Gmail
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: s.gmailUser, pass: s.gmailAppPassword },
  })
}

function senderAddress(s) {
  if (s.smtpHost) return s.smtpUser
  return s.gmailUser
}

async function sendExcel({ xlsxPath, brand, recipientEmail, gmailUser, gmailAppPassword, smtpHost, smtpPort, smtpUser, smtpPass }) {
  if (!fs.existsSync(xlsxPath)) {
    throw new Error(`File Excel non trovato: ${xlsxPath}`)
  }

  const s = { gmailUser, gmailAppPassword, smtpHost, smtpPort, smtpUser, smtpPass }
  const transporter = buildTransport(s)
  const from = senderAddress(s)

  const filename = path.basename(xlsxPath)
  const now = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' })

  const info = await transporter.sendMail({
    from: `Scraper Valerio <${from}>`,
    to: recipientEmail,
    subject: `[Valerio Scraper] Prodotti ${brand} – ${now}`,
    text: [
      `Ciao,`,
      ``,
      `In allegato trovi il file Excel aggiornato con i prodotti "${brand}".`,
      ``,
      `Data aggiornamento: ${now}`,
      `File: ${filename}`,
      ``,
      `-- Scraper automatico Valerio`
    ].join('\n'),
    attachments: [
      {
        filename,
        path: xlsxPath,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      }
    ]
  })

  console.log(`Email inviata a ${recipientEmail} (messageId: ${info.messageId})`)
  return info
}

module.exports = { sendExcel, buildTransport, senderAddress }
