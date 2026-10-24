import { actions, keys } from './browser/contract.mjs';

export function browserTool(channel) {
  return {
    name: 'browse',
    description: 'Use the independent agent browser for websites, app verification, forms, tabs, HTML file-input uploads, download status and supported dialogs. File System Access Save/Open/Directory pickers and general OS file operations are unsupported. Observe fresh page state; inspect capabilities and browser-generated requests, then respond using their offered refs. Protected requests require the registered delegation policy. Not for plain URL text retrieval. Human sign-in/OS identity and explicit Stop remain boundaries; never bypass refusal or resume a stopped page.',
    inputSchema: {
      type: 'object',
      required: ['action', '_channel'],
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: actions },
        _channel: { type: 'string', enum: [channel], description: 'This server connection; copy this exact constant.' },
        _lease: { type: 'string', description: 'Injected by the plugin host hook. Do not invent a value.' },
        tabId: { type: 'string', description: 'Owned tabId returned by this connection.' },
        url: { type: 'string', description: 'Credential-free HTTP(S) URL for open or navigate.' },
        ref: { type: 'string', description: 'A ref from the latest observation only.' },
        target: {
          type: 'object', additionalProperties: false,
          properties: {
            role: { type: 'string' }, name: { type: 'string' }, exact: { type: 'boolean' },
            selector: { type: 'string' }, frameId: { type: 'string' },
          },
          description: 'Known semantic target; at least role, name or selector. Ambiguity returns fresh candidates.',
        },
        point: {
          type: 'object', required: ['x', 'y', 'snapshotId'], additionalProperties: false,
          properties: { x: { type: 'number' }, y: { type: 'number' }, snapshotId: { type: 'string' } },
          description: 'CSS viewport coordinates, grounded in the latest combined DOM+PNG snapshot.',
        },
        text: { type: 'string', maxLength: 100000 },
        key: { type: 'string', enum: Object.keys(keys) },
        values: { type: 'array', items: { type: 'string' } },
        deltaX: { type: 'number', minimum: -10000, maximum: 10000 },
        deltaY: { type: 'number', minimum: -10000, maximum: 10000 },
        expression: { type: 'string', description: 'DOM JavaScript in a separate isolated world; no page-main globals or host authority.' },
        frameId: { type: 'string' },
        files: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string' }, description: 'Absolute regular files for an explicit file-input target.' },
        accept: { type: 'boolean' },
        promptText: { type: 'string' },
        requestRef: { type: 'string', maxLength: 128, description: 'An owned pending native request returned by observe or requests.' },
        response: {
          type: 'object', additionalProperties: false,
          properties: {
            optionRef: { type: 'string', maxLength: 128 },
            files: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string' } },
            text: { type: 'string', maxLength: 100000 },
            cancel: { type: 'boolean', enum: [true] },
          },
          description: 'Exactly one current optionRef, explicit file paths, or cancel:true. text is only for a prompt dialog option.',
        },
      },
    },
  };
}

export function toolResult(result) {
  let text = result, image;
  if (result?.screenshot) {
    const { screenshot, ...body } = result;
    image = screenshot;
    text = { ...body, screenshot: { ...screenshot, data: undefined } };
  } else if (result?.observation?.screenshot) {
    const { screenshot, ...observation } = result.observation;
    image = screenshot;
    text = { ...result, observation: { ...observation, screenshot: { ...screenshot, data: undefined } } };
  }
  return {
    isError: result?.disposition === 'uncertain',
    content: [
      { type: 'text', text: JSON.stringify(text) },
      ...(image ? [{ type: 'image', mimeType: 'image/png', data: image.data }] : []),
    ],
  };
}
