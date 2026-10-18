/** Prefix each diagnostic line with local time, including three-digit milliseconds. */
export function timestampLog(text: string, now = new Date()): string {
	const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
	const date = `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
	return text.split(/\r?\n/).map((line) => `[${date} ${time}] ${line}`).join("\n");
}
