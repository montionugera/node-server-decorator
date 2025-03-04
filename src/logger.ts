export interface Logger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

export let globalLogger: Logger = {
    debug: (message: string) => console.debug(message),
    info: (message: string) => console.info(message),
    warn: (message: string) => console.warn(message),
    error: (message: string) => console.error(message),
};

export function setGlobalLogger(logger: Logger) {
    globalLogger = logger;
}