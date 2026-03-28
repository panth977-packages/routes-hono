import { type Context, Hono } from "@hono/hono";
import { F } from "@panth977/functions";
import { R } from "@panth977/routes";
import { T } from "@panth977/tools";
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

export class HonoHttpContext extends F.Context {
  c: Context;

  constructor(
    requestId: string,
    c: Context,
  ) {
    super(requestId, `${c.req.method}, ${c.req.url}`, null);
    this.c = c;
    HonoState.set(this, [c]);
  }

  static readonly zFile: z.ZodType<
    Blob,
    z.ZodTypeDef,
    Blob
  > = z.instanceof(Blob);

  reqForMiddleware(): {
    headers: Record<string, string>;
    query: Record<string, string | string[]>;
  } {
    return {
      headers: this.c.req.header(),
      query: toQuery(this.c.req.query(), this.c.req.queries()),
    };
  }
  async req(): Promise<{
    headers: Record<string, string>;
    path: Record<string, string>;
    query: Record<string, string | string[]>;
    body: any;
  }> {
    return {
      headers: this.c.req.header(),
      path: this.c.req.param(),
      query: toQuery(this.c.req.query(), this.c.req.queries()),
      body: this.c.req.method.toLowerCase() === "get"
        ? null
        : await this.c.req.json().catch(() => null),
    };
  }

  static async honoHandler(
    createContext: (c: Context) => HonoHttpContext | Promise<HonoHttpContext>,
    onError: (context: HonoHttpContext, err: unknown) => {
      status: number;
      headers?: Record<string, string[] | string>;
      message: string;
    },
    build: R.FuncHttpExported<R.HttpInput, R.HttpOutput, R.HttpTypes>,
    c: Context,
  ): Promise<Response> {
    const context = await createContext(c);
    context.logDebug("🔁", c.req.url);
    const headers: Record<string, string | string[]> = {};
    function addHeaders(result: { headers?: Record<string, string[] | string> }) {
      if (result.headers) {
        for (const key in result.headers) {
          if (headers[key] === undefined) {
            headers[key] = result.headers[key];
          } else {
            headers[key] = [
              ...(Array.isArray(headers[key]) ? headers[key] : [headers[key]]),
              ...(Array.isArray(result.headers[key])
                ? result.headers[key]
                : [result.headers[key]]),
            ];
          }
        }
      }
    }
    try {
      for (const middleware of build.node.middlewares) {
        const input = context.reqForMiddleware();
        const result = await middleware(context, input);
        R.FuncMiddleware.setOpt(context, middleware.node, result.opt);
        addHeaders(result);
      }
      const input = await context.req();
      const result = await build(context, input);
      addHeaders(result);
      const content = result.body;
      context.logDebug("🔚:✅", context.c.req.url);
      headers["Access-Control-Allow-Origin"] ??= "*";
      if (content instanceof Blob) {
        const arrayBuffer = await content.arrayBuffer();
        headers["Content-Length"] ??= content.size.toString();
        headers["Content-Type"] ??= content.type;
        return context.c.body(arrayBuffer, 200, headers);
      }
      if ("Content-Type" in headers && typeof content === "string") {
        return context.c.text(content, 200, headers);
      }
      return context.c.json(content, 200, headers);
    } catch (err) {
      const result = onError(context, err);
      addHeaders(result);
      context.logDebug("🔚:❌", context.c.req.url);
      return context.c.text(
        result.message,
        result.status as never,
        headers,
      );
    } finally {
      HonoHttpContext.dispose(context);
    }
  }
}

export class HonoSseContext extends F.Context {
  controller?: ReadableStreamDefaultController;
  c: Context;

  constructor(
    requestId: string,
    c: Context,
  ) {
    super(requestId, `${c.req.method}, ${c.req.url}`, null);
    this.c = c;
    HonoState.set(this, [c]);
  }

  req(): {
    path: Record<string, string>;
    query: Record<string, string | string[]>;
  } {
    return {
      path: this.c.req.param(),
      query: toQuery(this.c.req.query(), this.c.req.queries()),
    };
  }

  static async honoHandler(
    createContext: (c: Context) => HonoSseContext | Promise<HonoSseContext>,
    onError: (context: HonoSseContext, err: unknown) => string,
    build: R.FuncSseExported<R.SseInput, R.SseOutput, R.SseTypes>,
    c: Context,
  ): Promise<Response> {
    const context = await createContext(c);
    context.logDebug("🔁", c.req.url);
    const stream = new T.PStream<string>();
    (async function () {
      try {
        let isCanceled = false;
        stream.onAbort(() => {
          context.logDebug("🔚:‼️", context.c.req.url);
          isCanceled = true;
        });
        try {
          for (const middleware of build.node.middlewares) {
            const input = context.req();
            const result = await middleware(context, input);
            if (isCanceled) return;
            R.FuncMiddleware.setOpt(context, middleware.node, result.opt);
          }
        } catch (err) {
          stream.emit(onError(context, err));
          stream.close();
        }
        await T.PStream.TransferStream(build(context, context.req()), stream, {
          listen(data) {
            stream.emit(`data: ${build.node.encoder(data)}\n\n`);
          },
          onError(err) {
            context.logDebug("🔚:❌", context.c.req.url);
            stream.emit(`data: ${onError(context, err)}\n\n`);
            stream.close();
          },
          onEnd() {
            context.logDebug("🔚:✅", context.c.req.url);
            stream.close();
          },
        });
      } catch (err) {
        context.logDebug("🔚:❌", context.c.req.url);
        stream.emit(`data: ${onError(context, err)}\n\n`);
        stream.close();
      } finally {
        HonoSseContext.dispose(context);
      }
    })();
    return c.body(stream.stream.pipeThrough(new TextEncoderStream()), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
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
      const handler = HonoHttpContext.honoHandler.bind(
        HonoHttpContext,
        onHttpReq,
        onHttpError,
        build,
      );
      for (const path of build.node.paths) {
        for (const method of build.node.methods) {
          app[method](pathParser(path, build.node.reqPath), handler);
        }
      }
    } else if (R.isSseExport(build)) {
      if (!onSseReq) throw new Error("Need [onSseReq]");
      if (!onSseError) throw new Error("Need [onSseError]");
      const handler = HonoSseContext.honoHandler.bind(
        HonoSseContext,
        onSseReq,
        onSseError,
        build,
      );
      for (const path of build.node.paths) {
        for (const method of build.node.methods) {
          app[method](pathParser(path, build.node.reqPath), handler);
        }
      }
    }
  }
  return app;
}
