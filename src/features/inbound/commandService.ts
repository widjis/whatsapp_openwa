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

function truncate(value: string, maxLength = 120): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`
}

export class InboundCommandService {
  private readonly allowedPhones: string[]

  constructor(
    private readonly messaging: MessagingService,
    allowedPhoneNumbers: string[]
  ) {
    this.allowedPhones = allowedPhoneNumbers.map(normalizePhoneDigits).filter(Boolean)
    console.log('[command:init]', JSON.stringify({
      allowedPhoneCount: this.allowedPhones.length,
      accessMode: this.allowedPhones.length > 0 ? 'restricted' : 'open',
    }))
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
    console.log('[command:incoming]', JSON.stringify({
      eventType: event.eventType,
      sessionId: event.sessionId,
      chatId: event.chatId,
      senderId: event.senderId,
      isGroup: event.isGroup,
      messageId: event.messageId,
      textPreview: truncate(event.text),
    }))

    const result = this.handleCommandText(event.text, event.senderId)
    if (!result.handled || !result.replyText) {
      console.log('[command:ignored]', JSON.stringify({
        reason: 'not_a_supported_command',
        textPreview: truncate(event.text),
      }))
      return { handled: false }
    }

    console.log('[command:matched]', JSON.stringify({
      commandName: result.commandName ?? null,
      willReply: true,
      replyPreview: truncate(result.replyText),
    }))

    try {
      await this.reply(event.chatId, result.replyText)
      console.log('[command:reply_sent]', JSON.stringify({
        commandName: result.commandName ?? null,
        chatId: event.chatId,
      }))
    } catch (error) {
      console.error('[command:reply_failed]', JSON.stringify({
        commandName: result.commandName ?? null,
        chatId: event.chatId,
        message: error instanceof Error ? error.message : String(error),
      }))
      throw error
    }

    return { handled: true, commandName: result.commandName }
  }
}
