export interface GhosttyTerminalOptions {
  cursorBlink?: boolean;
  fontSize?: number;
  theme?: {
    background?: string;
    foreground?: string;
  };
}

export class FitAddon {
  fit(): void;
  observeResize(): void;
}

export class Terminal {
  constructor(options?: GhosttyTerminalOptions);
  loadAddon(addon: FitAddon): void;
  open(element: HTMLElement): void;
  write(data: string): void;
  onData(callback: (data: string) => void): void;
  onResize(callback: (size: { cols: number; rows: number }) => void): void;
  dispose(): void;
}

export function init(): Promise<void>;
