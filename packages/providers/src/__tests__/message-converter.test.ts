import {
  extractAnthropicText,
  extractAnthropicToolCalls,
  toAnthropicMessages,
  toGeminiMessages,
  toOpenAiChatMessages,
  toOpenAiResponsesRequest,
} from '@mozi/providers';
import type { AnthropicContentBlock } from '@mozi/providers';
import type { ChatMessage } from '@mozi/shared';
/**
 * 消息格式转换器测试（T2 扩展）：
 * 验证内部 ChatMessage -> 四种 Provider 格式的转换正确性。
 * 零 API 成本，纯确定性测试。
 */
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------

const systemMsg = { role: 'system' as const, content: 'You are a helpful assistant.' };
const userTextMsg = { role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] };
const userImageMsg = {
  role: 'user' as const,
  content: [{ type: 'image' as const, dataUrl: 'data:image/png;base64,ABC123' }],
};
const userMultiMsg = {
  role: 'user' as const,
  content: [
    { type: 'text' as const, text: 'Look at this' },
    { type: 'image' as const, dataUrl: 'data:image/jpeg;base64,XYZ' },
  ],
} as ChatMessage;
const assistantTextMsg = {
  role: 'assistant' as const,
  content: 'Hi there!',
  toolCalls: undefined,
} as ChatMessage;
const assistantToolMsg = {
  role: 'assistant' as const,
  content: null,
  toolCalls: [
    { id: 'tc1', name: 'read_file', arguments: '{"path":"test.txt"}', riskLevel: 'read' as const },
  ],
} as ChatMessage;
const toolResultMsg = {
  role: 'tool' as const,
  callId: 'tc1',
  content: 'file contents...',
  isError: false,
} as ChatMessage;

describe('消息格式转换器', () => {
  describe('Anthropic Messages 转换', () => {
    it('转换系统提示 + 用户文本', () => {
      const result = toAnthropicMessages([systemMsg, userTextMsg]);
      expect(result.system).toBe('You are a helpful assistant.');
      expect(result.messages).toHaveLength(1);
      const m0 = result.messages[0]!;
      expect(m0.role).toBe('user');
      expect(m0.content).toHaveLength(1);
      const c0 = m0.content[0]!;
      expect(c0.type).toBe('text');
      if (c0.type === 'text') {
        expect(c0.text ?? '').toBe('Hello');
      }
    });

    it('转换多用户消息（无系统提示）', () => {
      const result = toAnthropicMessages([userMultiMsg]);
      expect(result.system).toEqual([{ type: 'text', text: '' }]);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.content).toHaveLength(2);
    });

    it('转换 assistant tool_use 消息', () => {
      const result = toAnthropicMessages([userTextMsg, assistantToolMsg]);
      const assistantBlock = result.messages[1]!;
      expect(assistantBlock.role).toBe('assistant');
      const toolBlock = assistantBlock.content.find(
        (b: AnthropicContentBlock) => b.type === 'tool_use',
      );
      expect(toolBlock).toBeTruthy();
      if (!toolBlock) return;
      expect(toolBlock.type).toBe('tool_use');
      expect(toolBlock.id).toBe('tc1');
      expect(toolBlock.name).toBe('read_file');
      expect(toolBlock.input.path).toBe('test.txt');
    });

    it('转换 tool_result 消息', () => {
      const result = toAnthropicMessages([userTextMsg, assistantToolMsg, toolResultMsg]);
      const toolMsg = result.messages[2]!;
      expect(toolMsg.role).toBe('user');
      const contentBlock = toolMsg.content[0]!;
      expect(contentBlock.type).toBe('tool_result');
      if (contentBlock.type === 'tool_result') {
        expect(contentBlock.tool_use_id).toBe('tc1');
        expect(contentBlock.content).toBe('file contents...');
      }
    });

    it('转换图片消息', () => {
      const result = toAnthropicMessages([userImageMsg]);
      const imgBlock = result.messages[0]?.content[0]!;
      expect(imgBlock.type).toBe('image');
      if (imgBlock.type === 'image') {
        expect(imgBlock.source.type).toBe('base64');
        expect(imgBlock.source.media_type).toBe('image/png');
        expect(imgBlock.source.data).toBe('ABC123');
      }
    });

    it('转换工具定义', () => {
      const tools = [
        {
          name: 'shell',
          description: 'Run shell command',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      ];
      const result = toAnthropicMessages([userTextMsg], { tools });
      expect(result.tools).toHaveLength(1);
      const t = result.tools?.[0]!;
      expect(t.name).toBe('shell');
      expect(t.description).toBe('Run shell command');
      expect(t.input_schema.type).toBe('object');
    });
  });

  describe('OpenAI Chat Completions 转换', () => {
    it('转换系统提示 + 用户文本', () => {
      const result = toOpenAiChatMessages([systemMsg, userTextMsg]);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
      expect(result[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Hello' }] });
    });

    it('转换 assistant tool_calls', () => {
      const result = toOpenAiChatMessages([userTextMsg, assistantToolMsg]);
      const assistant = result[1] as Record<string, unknown>;
      expect(assistant.role).toBe('assistant');
      expect(assistant.tool_calls).toHaveLength(1);
      const tc = (assistant.tool_calls as unknown[])[0] as Record<string, unknown>;
      expect(tc.id).toBe('tc1');
      expect(tc.type).toBe('function');
      expect((tc.function as { name: string }).name).toBe('read_file');
      expect((tc.function as { arguments: string }).arguments).toBe('{"path":"test.txt"}');
    });

    it('转换 tool 结果', () => {
      const result = toOpenAiChatMessages([userTextMsg, assistantToolMsg, toolResultMsg]);
      const tool = result[2] as Record<string, unknown>;
      expect(tool.role).toBe('tool');
      expect(tool.tool_call_id).toBe('tc1');
      expect(tool.content).toBe('file contents...');
    });

    it('转换图片消息', () => {
      const result = toOpenAiChatMessages([userImageMsg]);
      const user = result[0] as Record<string, unknown>;
      expect(user.role).toBe('user');
      const img = (user.content as unknown[])[0] as Record<string, unknown>;
      expect(img.type).toBe('image_url');
      expect((img.image_url as { url: string }).url).toBe('data:image/png;base64,ABC123');
    });
  });

  describe('OpenAI Responses API 转换', () => {
    it('转换用户文本（无系统提示）', () => {
      const result = toOpenAiResponsesRequest([userTextMsg]);
      expect(result.input).toHaveLength(1);
      const input = result.input as Array<{ role: string; content: unknown }>;
      expect((input[0]! as { role: string }).role).toBe('user');
    });

    it('跳过系统消息', () => {
      const result = toOpenAiResponsesRequest([systemMsg, userTextMsg]);
      const input = result.input as Array<{ role: string }>;
      expect(input.length).toBe(1);
      expect((input[0]! as { role: string }).role).toBe('user');
    });

    it('转换多内容用户消息为数组', () => {
      const result = toOpenAiResponsesRequest([userMultiMsg]);
      const input = result.input as Array<{ role: string; content: unknown }>;
      expect(Array.isArray((input[0]! as { content: unknown }).content)).toBe(true);
    });

    it('转换 assistant 消息', () => {
      const result = toOpenAiResponsesRequest([userTextMsg, assistantTextMsg]);
      const input = result.input as Array<{ role: string; content: string }>;
      expect((input[1]! as { role: string }).role).toBe('assistant');
      expect((input[1]! as { content: string }).content).toBe('Hi there!');
    });

    it('转换工具定义', () => {
      const tools = [
        {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ];
      const result = toOpenAiResponsesRequest([userTextMsg], { tools });
      expect(result.tools).toHaveLength(1);
      const t = result.tools?.[0]!;
      expect(t.name).toBe('read_file');
      expect(t.description).toBe('Read a file');
    });
  });

  describe('Gemini generateContent 转换', () => {
    it('转换系统提示为 systemInstruction', () => {
      const result = toGeminiMessages([systemMsg, userTextMsg]);
      expect(result.systemInstruction).toBeTruthy();
      const si = result.systemInstruction!;
      expect(si.role).toBe('system');
      expect(si.parts).toHaveLength(1);
      expect(si.parts[0]?.type).toBe('text');
      if (si.parts[0]?.type === 'text') {
        expect(si.parts[0]?.text).toBe('You are a helpful assistant.');
      }
    });

    it('转换用户文本', () => {
      const result = toGeminiMessages([userTextMsg]);
      expect(result.contents).toHaveLength(1);
      const c0 = result.contents[0]!;
      expect(c0.role).toBe('user');
      expect(c0.parts).toHaveLength(1);
      expect(c0.parts[0]?.type).toBe('text');
      if (c0.parts[0]?.type === 'text') {
        expect(c0.parts[0]?.text).toBe('Hello');
      }
    });

    it('转换 assistant function_call', () => {
      const result = toGeminiMessages([userTextMsg, assistantToolMsg]);
      const model = result.contents[1]!;
      expect(model.role).toBe('model');
      const fc = model.parts.find((p) => p.type === 'function_call');
      expect(fc).toBeTruthy();
      if (fc && fc.type === 'function_call') {
        expect(fc.functionCall.name).toBe('read_file');
        expect((fc.functionCall.args as { path: string }).path).toBe('test.txt');
      }
    });

    it('转换 tool_result 为 function_response', () => {
      const result = toGeminiMessages([userTextMsg, assistantToolMsg, toolResultMsg]);
      const funcMsg = result.contents[2]!;
      expect(funcMsg.role).toBe('function');
      const fr = funcMsg.parts[0]!;
      expect(fr.type).toBe('function_response');
      if (fr.type === 'function_response') {
        expect(fr.functionResponse.name).toBe('tool_tc1');
        const resp = fr.functionResponse.response;
        expect(resp?.result).toBe('file contents...');
      }
    });

    it('转换图片消息', () => {
      const result = toGeminiMessages([userImageMsg]);
      const part = result.contents[0]?.parts[0]!;
      expect(part.type).toBe('inline_data');
      if (part.type === 'inline_data') {
        expect(part.mime_type).toBe('image/png');
        expect(part.data).toBe('ABC123');
      }
    });

    it('转换工具定义', () => {
      const tools = [{ name: 'glob', description: 'Glob files', parameters: { type: 'object' } }];
      const result = toGeminiMessages([userTextMsg], { tools });
      expect(result.tools).toHaveLength(1);
      const decl = result.tools?.[0]?.functionDeclarations[0]!;
      expect(decl.name).toBe('glob');
    });
  });

  describe('Anthropic 逆向解析', () => {
    it('提取文本内容', () => {
      const blocks: AnthropicContentBlock[] = [
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', id: 'tc1', name: 'read', input: {} },
        { type: 'text', text: 'Done' },
      ] as AnthropicContentBlock[];
      expect(extractAnthropicText(blocks)).toBe('Hello\nDone');
    });

    it('提取工具调用', () => {
      const blocks: AnthropicContentBlock[] = [
        { type: 'text', text: 'Calling tool' },
        { type: 'tool_use', id: 'tc1', name: 'shell', input: { command: 'ls' } },
      ] as AnthropicContentBlock[];
      const calls = extractAnthropicToolCalls(blocks);
      expect(calls).toHaveLength(1);
      const c0 = calls[0]!;
      expect(c0.id).toBe('tc1');
      expect(c0.name).toBe('shell');
    });
  });
});
