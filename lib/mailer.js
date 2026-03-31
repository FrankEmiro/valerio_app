/**
 * mailer.js – Invia l'Excel via Gmail con nodemailer
 *
 * Richiede Gmail App Password:
 * 1. Abilita 2FA su Google Account
 * 2. Vai su myaccount.google.com/apppasswords
 * 3. Crea App Password "Mail" → copia le 16 cifre
 * 4. Imposta GMAIL_APP_PASSWORD nel .env
 */

const nodemailer = require('nodemailer')
const path = require('path')
const fs = require('fs')

async function sendExcel({ xlsxPath, brand, recipientEmail, gmailUser, gmailAppPassword }) {
  if (!fs.existsSync(xlsxPath)) {
    throw new Error(`File Excel non trovato: ${xlsxPath}`)
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: gmailUser,
      pass: gmailAppPassword
    }
  })

  const filename = path.basename(xlsxPath)
  const now = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' })

  const mailOptions = {
    from: `Scraper PartsEurope <${gmailUser}>`,
    to: recipientEmail,
    subject: `[PartsEurope] Prodotti ${brand} – ${now}`,
    text: [
      `Ciao,`,
      ``,
      `In allegato trovi il file Excel aggiornato con i prodotti del brand "${brand}" scaricati da partseurope.eu.`,
      ``,
      `Data aggiornamento: ${now}`,
      `File: ${filename}`,
      ``,
      `-- Scraper automatico PartsEurope`
    ].join('\n'),
    attachments: [
      {
        filename,
        path: xlsxPath,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      }
    ]
  }

  const info = await transporter.sendMail(mailOptions)
  console.log(`Email inviata a ${recipientEmail} (messageId: ${info.messageId})`)
  return info
}

module.exports = { sendExcel }
