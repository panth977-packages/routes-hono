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

  static readonly zFile: z.ZodType<
    Blob,
    z.ZodTypeDef,
    Blob
  > = z.instanceof(Blob);

  private reqForMiddleware() {
    return {
      headers: this.c.req.header(),
      query: toQuery(this.c.req.query(), this.c.req.queries()),
    };
  }
  private async req() {
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
    onHttpReq: (c: Context) => HonoHttpContext | Promise<HonoHttpContext>,
    onError: (context: HonoHttpContext, err: unknown) => {
      status: number;
      headers?: Record<string, string[] | string>;
      message: string;
    },
    build: R.FuncHttpExported<R.HttpInput, R.HttpOutput, R.HttpTypes>,
    c: Context,
  ): Promise<Response> {
    const context = await onHttpReq(c);
    context.logDebug("🔁", c.req.url);
    try {
      const result = await R.executeHttp(
        context,
        build,
        {
          onError,
          handlerReq: context.req.bind(context),
          middlewareReq: context.reqForMiddleware.bind(context),
        },
      );
      if (result.type === "success") {
        context.logDebug("🔚:✅", context.c.req.url);
        result.headers["Access-Control-Allow-Origin"] ??= "*";
        if (result.content instanceof Blob) {
          const arrayBuffer = await result.content.arrayBuffer();
          result.headers["Content-Length"] ??= result.content.size.toString();
          result.headers["Content-Type"] ??= result.content.type;
          return context.c.body(arrayBuffer, 200, result.headers);
        }
        if (
          "Content-Type" in result.headers && typeof result.content === "string"
        ) {
          return context.c.text(result.content, 200, result.headers);
        }
        return context.c.json(result.content, 200, result.headers);
      } else {
        context.logDebug("🔚:❌", context.c.req.url);
        return context.c.text(
          result.message,
          result.status as never,
          result.headers,
        );
      }
    } finally {
      HonoHttpContext.dispose(context);
    }
  }
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

  private req() {
    return {
      path: this.c.req.param(),
      query: toQuery(this.c.req.query(), this.c.req.queries()),
    };
  }

  static async honoHandler(
    onSseReq: (c: Context) => HonoSseContext | Promise<HonoSseContext>,
    onError: (context: HonoSseContext, err: unknown) => string,
    build: R.FuncSseExported<R.SseInput, R.SseOutput, R.SseTypes>,
    c: Context,
  ): Promise<Response> {
    const context = await onSseReq(c);
    context.logDebug("🔁", c.req.url);
    const stream = new T.PStream<string>();
    const out = R.executeSse(context, build, {
      req: context.req.bind(context),
      onError,
    });
    (async function () {
      try {
        let isCanceled = false;
        stream.onAbort(() => isCanceled = true)
        for await (const element of T.PStream.Iterable(out, stream.onAbort.bind(stream))) {
          stream.emit(element);
        }
        if (isCanceled) {
          context.logDebug("🔚:‼️", context.c.req.url);
        } else {
          context.logDebug("🔚:✅", context.c.req.url);
          stream.close();
        }
      } catch (err) {
        context.logDebug("🔚:❌", context.c.req.url);
        stream.error(err);
      } finally {
        HonoSseContext.dispose(context);
      }
    })();
    return c.body(stream.stream, {
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
