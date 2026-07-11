import type { MessagingService } from '../channel/messagingService.js'
import type { InboundMessageEvent } from '../channel/eventNormalizer.js'
import { extractDigitsFromJid, normalizePhoneDigits } from '../../utils/phone.js'

type CommandHandleResult = {
  handled: boolean
  commandName?: string
  replyText?: string
}

const HELP_TEXT = [
  '*OpenWA Rebuild Command POC*',
  '- /hi',
  '- /help',
  '- /ping',
  '- /resetpassword <username> <newPassword> [/change]',
  '',
  'Catatan:',
  '- ini masih jalur inbound POC',
  '- integrasi LDAP/Snipe-IT full dari reference belum dipindah ke root app',
].join('\n')

export class InboundCommandService {
  private readonly allowedPhones: string[]

  constructor(
    private readonly messaging: MessagingService,
    allowedPhoneNumbers: string[]
  ) {
    this.allowedPhones = allowedPhoneNumbers.map(normalizePhoneDigits).filter(Boolean)
  }

  private isAllowed(senderId: string): boolean {
    if (this.allowedPhones.length < 1) return true
    const senderDigits = normalizePhoneDigits(extractDigitsFromJid(senderId))
    return this.allowedPhones.includes(senderDigits)
  }

  private async reply(chatId: string, text: string): Promise<void> {
    await this.messaging.sendText({ chatId, text })
  }

  private handleCommandText(text: string, senderId: string): CommandHandleResult {
    const trimmed = text.trim()
    if (!trimmed.startsWith('/')) return { handled: false }

    const parts = trimmed.split(/\s+/)
    const command = parts[0]?.toLowerCase() ?? ''

    switch (command) {
      case '/hi':
        return { handled: true, commandName: 'hi', replyText: 'Hello! inbound command path sudah hidup.' }
      case '/ping':
        return { handled: true, commandName: 'ping', replyText: 'pong - webhook -> parser -> command -> reply berjalan.' }
      case '/help':
        return { handled: true, commandName: 'help', replyText: HELP_TEXT }
      case '/resetpassword': {
        if (!this.isAllowed(senderId)) {
          return { handled: true, commandName: 'resetpassword', replyText: 'Access denied.' }
        }

        const username = parts[1]
        const newPassword = parts[2]
        const changeFlag = parts[3] === '/change'

        if (!username || !newPassword) {
          return {
            handled: true,
            commandName: 'resetpassword',
            replyText: 'Usage: /resetpassword <username> <newPassword> [/change]',
          }
        }

        return {
          handled: true,
          commandName: 'resetpassword',
          replyText:
            `Inbound command captured.\n` +
            `Command: /resetpassword\n` +
            `User: ${username}\n` +
            `Change next logon: ${changeFlag ? 'yes' : 'no'}\n\n` +
            `POC only: handler root app sudah menerima command, tapi integrasi LDAP dari reference belum dipindah.`,
        }
      }
      default:
        return {
          handled: true,
          commandName: command.replace(/^\//, ''),
          replyText: `Command ${command} belum dipindah ke root app. Kirim /help untuk command POC yang sudah aktif.`,
        }
    }
  }

  async processInboundMessage(event: InboundMessageEvent): Promise<{ handled: boolean; commandName?: string }> {
    const result = this.handleCommandText(event.text, event.senderId)
    if (!result.handled || !result.replyText) {
      return { handled: false }
    }

    await this.reply(event.chatId, result.replyText)
    return { handled: true, commandName: result.commandName }
  }
}
