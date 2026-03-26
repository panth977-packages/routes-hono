import { type Context, Hono } from "@hono/hono";
import { F } from "@panth977/functions";
import { R } from "@panth977/routes";
import { z } from "zod";

/**
 * Converts {param} syntax to Hono's :param syntax with regex constraints
 */
export function pathParser<
  I extends R.HttpInput,
  O extends R.HttpOutput,
  Type extends R.HttpTypes,
>(
  path: string,
  schema: R.FuncHttp<I, O, Type>["reqPath"],
): string {
  if (schema instanceof z.ZodObject) {
    return path.replace(/{([^}]+)}/g, (_, x) => {
      const s = schema.shape[x];
      if (s instanceof z.ZodEnum) {
        const enums = Object.keys(s.enum).join("|");
        return `:${x}{${enums}}`;
      }
      if (s instanceof z.ZodNumber) {
        return `:${x}{\\d+}`;
      }
      return `:${x}`;
    });
  }
  return path.replace(/{([^}]+)}/g, ":$1");
}

export const HonoState: F.ContextState<[Context]> = F.ContextState.Tree<
  [Context]
>("Middleware", "create&read");

function toQuery(
  query: Record<string, string>,
  queries: Record<string, string[]>,
) {
  const q: Record<string, string | string[]> = {};
  for (const key of new Set([...Object.keys(query), ...Object.keys(queries)])) {
    if (key.endsWith("[]")) {
      const k = key.slice(0, -2);
      q[k] = [
        ...(q[k] ?? []),
        ...(queries[key] ?? []),
        ...(query[key] ? [query[key]] : []),
      ];
    } else if (key in queries && queries[key].length > 1) {
      q[key] = [...queries[key], ...(query[key] ? [query[key]] : [])];
    } else {
      q[key] = query[key];
    }
  }
  return q;
}

export class HonoHttpContext extends R.RouteContext {
  c: Context;

  constructor(
    requestId: string,
    c: Context,
  ) {
    super(requestId, `${c.req.method}, ${c.req.url}`);
    this.c = c;
    HonoState.set(this, [c]);
  }

  static readonly zFile: z.ZodType<Blob, z.ZodTypeDef, Blob> = z.instanceof(Blob);

  static handler: R.HttpHandlers<HonoHttpContext, Response> = {
    middlewareReq(context) {
      return {
        headers: context.c.req.header(),
        query: toQuery(context.c.req.query(), context.c.req.queries()),
      };
    },
    async handlerReq(context) {
      return {
        headers: context.c.req.header(),
        path: context.c.req.param(),
        query: toQuery(context.c.req.query(), context.c.req.queries()),
        body: await context.c.req.json().catch(() => null),
      };
    },
    successRes(context, contentType, headers, content) {
      headers["Access-Control-Allow-Origin"] = '*';
      headers["Content-Type"] = contentType;
      if (contentType === "application/json") {
        return context.c.json(content, 200, headers);
      } else if (typeof content === "string") {
        return context.c.text(content, 200, headers);
      } else if (content instanceof Blob) {
        return context.c.body(content.stream(), 200, headers);
      }
      throw new Error("Unknown Type");
    },
    errorRes(context, status, headers, message) {
      return context.c.text(message, status as never, headers);
    },
  };
}

export class HonoSseContext extends R.RouteContext {
  controller?: ReadableStreamDefaultController;
  c: Context;

  constructor(
    requestId: string,
    c: Context,
  ) {
    super(requestId, `${c.req.method}, ${c.req.url}`);
    this.c = c;
    HonoState.set(this, [c]);
  }

  static handler: R.SseHandlers<HonoSseContext, Response> = {
    req(context) {
      return {
        path: context.c.req.param(),
        query: toQuery(context.c.req.query(), context.c.req.queries()),
      };
    },
    start(context) {
      const stream = new ReadableStream({
        start: (controller) => {
          context.controller = controller;
        },
      });
      return context.c.body(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    },
    sendData(context, data) {
      try {
        context.controller?.enqueue(
          new TextEncoder().encode(`data: ${data}\n\n`),
        );
      } catch {
        // stream already closed/cancelled or parse error — skip
      }
    },
    endSuccess(context) {
      context.controller?.close();
    },
    endError(context, data) {
      try {
        context.controller?.enqueue(
          new TextEncoder().encode(`data: ${data}\n\n`),
        );
      } catch {
        // stream already closed/cancelled or parse error — skip
      }
      context.controller?.close();
    },
  };
}
async function httpHandler(
  onHttpReq: (c: Context) => HonoHttpContext | Promise<HonoHttpContext>,
  onHttpError: (
    context: HonoHttpContext,
    err: unknown,
  ) => {
    status: number;
    headers?: Record<string, string[] | string>;
    message: string;
  },
  build: R.FuncHttpExported<R.HttpInput, R.HttpOutput, R.HttpTypes>,
  c: Context,
) {
  const context = await onHttpReq(c);
  try {
    return await R.executeHttp(
      context,
      build,
      HonoHttpContext.handler,
      onHttpError,
    );
  } finally {
    HonoHttpContext.dispose(context);
  }
}
async function sseHandler(
  onSseReq: (c: Context) => HonoSseContext | Promise<HonoSseContext>,
  onSseError: (context: HonoSseContext, err: unknown) => string,
  build: R.FuncSseExported<R.SseInput, R.SseOutput, R.SseTypes>,
  c: Context,
) {
  const context = await onSseReq(c);
  return R.executeSse(
    context,
    build,
    HonoSseContext.handler,
    onSseError,
    F.Context.dispose,
  );
}
export function serve({
  bundle,
  onHttpReq,
  onSseReq,
  onHttpError,
  onSseError,
}: {
  bundle: Record<string, R.EndpointBuild>;
  onHttpReq?: (c: Context) => HonoHttpContext | Promise<HonoHttpContext>;
  onSseReq?: (c: Context) => HonoSseContext | Promise<HonoSseContext>;
  onHttpError?: (context: HonoHttpContext, err: unknown) => {
    status: number;
    headers?: Record<string, string[] | string>;
    message: string;
  };
  onSseError?: (context: HonoSseContext, err: unknown) => string;
}): Hono {
  const app = new Hono();
  for (
    const build of Object.values(bundle).sort((x, y) =>
      x.node.docsOrder - y.node.docsOrder
    )
  ) {
    if (R.isHttpExport(build)) {
      if (!onHttpReq) throw new Error("Need [onHttpReq]");
      if (!onHttpError) throw new Error("Need [onHttpError]");
      const handler = httpHandler.bind(null, onHttpReq, onHttpError, build);
      for (const path of build.node.paths) {
        for (const method of build.node.methods) {
          app[method](pathParser(path, build.node.reqPath), handler);
        }
      }
    } else if (R.isSseExport(build)) {
      if (!onSseReq) throw new Error("Need [onSseReq]");
      if (!onSseError) throw new Error("Need [onSseError]");
      const handler = sseHandler.bind(null, onSseReq, onSseError, build);
      for (const path of build.node.paths) {
        for (const method of build.node.methods) {
          app[method](pathParser(path, build.node.reqPath), handler);
        }
      }
    }
  }
  return app;
}
