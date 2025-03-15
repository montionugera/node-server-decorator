import { ConsoleLogger, Injectable, LogLevel } from '@nestjs/common'

@Injectable()
export class CustomLogger extends ConsoleLogger {
    logLevels: LogLevel[] = ['log', 'error', 'warn', 'debug', 'verbose']

    protected stringifyMsg(message: any): string {
        if (typeof message === 'string') {
            return message.replace(/\n/g, ' | ') // Replace newlines with " | "
        }
        return JSON.stringify(message) // Ensure objects are logged as JSON
    }

    protected formatMessage(message: any): string {
        const draftMsg = this.stringifyMsg(message)
        // Replace \" with " and  \\\\ with emptystring
        // return draftMsg
        const cleanSlashString = draftMsg
            .replace(/\\\\"/g, '"')
            .replace(/\\n/g, ' ')
        return cleanSlashString.substring(0, 1024)
    }

    private formatStack(stack?: string): string[] | undefined {
        return stack ? stack.split('\n').map((line) => line.trim()) : undefined
    }

    private logJson(level: string, message: any, stack?: string) {
        const logEntry = {
            level,
            message: this.formatMessage(message), // Format message to avoid \n issues
            stack: this.formatStack(stack), // Split stack into an array
            timestamp: new Date().toISOString(),
        }
        // Use console.dir() instead of JSON.stringify() to prevent Loki escaping issues
        console.log(logEntry, { depth: null })
    }

    log(message: any) {
        this.logJson('info', message)
    }

    info(message: any) {
        this.logJson('info', message)
    }

    error(message: any, trace?: string) {
        this.logJson('error', message, trace)
    }

    warn(message: any) {
        this.logJson('warn', message)
    }

    debug(message: any) {
        this.logJson('debug', message)
    }

    verbose(message: any) {
        this.logJson('verbose', message)
    }
}
