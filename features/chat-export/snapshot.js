import { parseFloorRanges } from './processor.js';

const MAX_CHARACTERS = 64 * 1024 * 1024;
const MAX_MESSAGES = 200000;
const pause = () => new Promise(resolve => setTimeout(resolve, 0));

/** Capture immutable strings only; never clone swipes, arbitrary extra or chat metadata. */
export async function snapshotChat(chat, options, { signal, isCurrent = () => true } = {}) {
    if (chat.length > MAX_MESSAGES) throw new Error('聊天超过 20 万楼，请拆分聊天后导出。');
    const ranges = parseFloorRanges(options.floors, chat.length - 1);
    const messages = new Array(chat.length);
    let rangeIndex = 0;
    let characters = [options.header?.user_name, options.header?.character_name]
        .reduce((total, name) => total + (typeof name === 'string' ? name.length : 0), 0);
    const checkSize = () => {
        if (characters > MAX_CHARACTERS) throw new Error('所选内容超过 64M 字符，请缩小楼层范围后分批导出。');
    };
    checkSize();
    const check = () => {
        if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
        if (!isCurrent()) throw new Error('聊天已变化，请重新执行操作。');
    };
    check();
    for (let floor = 0; floor < chat.length; floor++) {
        while (ranges[rangeIndex] && floor > ranges[rangeIndex][1]) rangeIndex++;
        const inRange = ranges[rangeIndex] && floor >= ranges[rangeIndex][0];
        const source = chat[floor] || {};
        const isUser = Boolean(source.is_user);
        const isSystem = Boolean(source.is_system);
        const matches = options.role === 'all'
            ? (!isSystem || options.includeSystem)
            : (!isSystem && (options.role === 'user' ? isUser : !isUser));
        // Retain positions for the zero-based floor parser without cloning unselected text.
        const message = { is_user: isUser, is_system: isSystem, mes: '' };
        if (inRange && matches) {
            message.name = typeof source.name === 'string' ? source.name : (isUser ? 'User' : 'Character');
            message.mes = typeof source.mes === 'string' ? source.mes : '';
            message.send_date = ['string', 'number'].includes(typeof source.send_date) ? source.send_date : '';
            if (typeof message.send_date === 'string' && message.send_date.length > 256) {
                throw new Error(`第 ${floor} 楼的时间字段异常（超过 256 字符），请修正该消息或排除此楼。`);
            }
            const reasoning = !options.removeReasoning && typeof source.extra?.reasoning === 'string'
                ? source.extra.reasoning : '';
            message.extra = reasoning ? { reasoning } : {};
            characters += message.name.length + message.mes.length + reasoning.length
                + (typeof message.send_date === 'string' ? message.send_date.length : 0);
            checkSize();
        }
        messages[floor] = message;
        if ((floor + 1) % 256 === 0) {
            await pause();
            check();
        }
    }
    check();
    return messages;
}
