type SerialPortOpenOptions = {
  baudRate: number;
};

interface SerialPort {
  readable: ReadableStream<any> | null;
  open(options: SerialPortOpenOptions): Promise<void>;
  close(): Promise<void>;
}

interface Serial {
  requestPort(): Promise<SerialPort>;
}

interface Navigator {
  serial: Serial;
}