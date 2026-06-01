import { useEffect, useRef, useState } from 'react';
import type { SerialConnectionState } from './types';

type Parser<T> = (line: string) => T | null;

export const useSerialSource = <T,>(parser: Parser<T>) => {
  const [connectionState, setConnectionState] = useState<SerialConnectionState>('idle');
  const [error, setError] = useState<string>('');
  const [lastLine, setLastLine] = useState<string>('');
  const [receivedLineCount, setReceivedLineCount] = useState(0);
  const [parsedValueCount, setParsedValueCount] = useState(0);
  const [parseErrorCount, setParseErrorCount] = useState(0);
  const [lastValueAt, setLastValueAt] = useState<number | null>(null);
  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<string> | null>(null);

  useEffect(() => {
    return () => {
      void disconnect();
    };
  }, []);

  const connect = async (onValue: (value: T) => void) => {
    if (!("serial" in navigator)) {
      setConnectionState('error');
      setError('Web Serial API를 지원하는 Chromium 브라우저가 필요합니다.');
      return;
    }

    try {
      setError('');
      setConnectionState('connecting');

      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      portRef.current = port;
      setLastLine('');
      setReceivedLineCount(0);
      setParsedValueCount(0);
      setParseErrorCount(0);
      setLastValueAt(null);

      const textDecoder = new TextDecoderStream();
      const readableClosed = port.readable?.pipeTo(textDecoder.writable);
      readerRef.current = textDecoder.readable.getReader();
      setConnectionState('streaming');

      let buffer = '';
      while (readerRef.current) {
        const { value, done } = await readerRef.current.read();
        if (done) {
          break;
        }

        buffer += value;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }

          setLastLine(trimmed);
          setReceivedLineCount((count) => count + 1);

          if (trimmed.startsWith('timestamp_ms')) {
            continue;
          }

          try {
            const parsed = parser(trimmed);
            if (parsed) {
              setParsedValueCount((count) => count + 1);
              setLastValueAt(Date.now());
              onValue(parsed);
            } else {
              setParseErrorCount((count) => count + 1);
            }
          } catch {
            setParseErrorCount((count) => count + 1);
          }
        }
      }

      await readableClosed?.catch(() => undefined);
    } catch (caughtError) {
      const isUserCancelled = caughtError instanceof DOMException && caughtError.name === 'NotFoundError';
      if (isUserCancelled) {
        setConnectionState('idle');
        setError('');
        return;
      }

      const message = caughtError instanceof Error ? caughtError.message : 'Serial connection failed.';
      setConnectionState('error');
      setError(message);
    }
  };

  const disconnect = async () => {
    try {
      await readerRef.current?.cancel();
      readerRef.current?.releaseLock();
      readerRef.current = null;
      await portRef.current?.close();
    } catch {
      // Ignore close errors from browsers that already detached the stream.
    } finally {
      portRef.current = null;
      setConnectionState('idle');
      setError('');
    }
  };

  return {
    connect,
    disconnect,
    connectionState,
    error,
    isSupported: 'serial' in navigator,
    lastLine,
    receivedLineCount,
    parsedValueCount,
    parseErrorCount,
    lastValueAt
  };
};