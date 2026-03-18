import { type Context, Hono } from "@hono/hono";
import { F } from "@panth977/functions";
import { R } from "@panth977/routes";
import { z } from "zod";

/**
 * Converts {param} syntax to Hono's :param syntax with regex constraints
 */
function pathParser<
  I extends R.HttpInput,
  O extends R.HttpOutput,
  Type extends R.HttpTypes,
>(path: string, schema: R.FuncHttp<I, O, Type>["reqPath"]): string {
  if (schema instanceof z.ZodObject) {
    return path.replace(/{([^}]+)}/g, (_, x) => {
      const s = schema.shape[x];
      if (s instanceof z.ZodEnum) {
        const enums = Object.keys(s.enum).join("|");
        return `:${x}{${enums}}`; // Hono uses {a|b} for regex
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

export class HonoHttpContext extends R.HttpContext {
  override middlewareReq(): R.PromiseLikeOr<{
    headers: Record<string, string | string[]>;
    query: Record<string, string | string[]>;
  }> {
    return {
      headers: this.c.req.header(),
      query: this.c.req.query(),
    };
  }
  override async handlerReq(): Promise<{
    headers: Record<string, string | string[]>;
    query: Record<string, string | string[]>;
    path: Record<string, string> | string[];
    body: any;
  }> {
    return {
      headers: this.c.req.header(),
      path: this.c.req.param(),
      query: this.c.req.query(),
      body: await this.c.req.json().catch(() => null),
    };
  }
  static debug = false;
  protected static onError(error: unknown) {
    if (this.debug) console.error(error);
  }

  private onComplete?: (res: any) => void;
  static onComplete(context: HonoHttpContext, fn: (res: any) => void) {
    context.onComplete = fn;
  }

  static async createHandler(
    onHttpReq: GenHttpContext,
    http: R.FuncHttpExported<R.HttpInput, R.HttpOutput, R.HttpTypes>,
    c: Context,
  ): Promise<any> {
    const context = await onHttpReq(c);
    context.logDebug("Req(🔁)", c.req.url);
    const promise = new Promise(
      HonoHttpContext.onComplete.bind(HonoHttpContext, context),
    );
    const executor = new R.HttpExecutor(context, http);
    executor.start();
    const ret = await promise;
    context.logDebug("Req(🔚)", c.req.url);
    return ret;
  }

  constructor(
    requestId: string,
    readonly c: Context,
    readonly onError: (
      context: HonoHttpContext,
      err: unknown,
    ) => {
      status: number;
      headers?: Record<string, string[] | string>;
      message: string;
    },
  ) {
    super(requestId, `${c.req.method}, ${c.req.url}`);
    HonoState.set(this, [c]);
  }

  override setResHeaders(headers: Record<string, string | string[]>): void {
    for (const key in headers) {
      if (Array.isArray(headers[key])) {
        this.c.header(key, headers[key].join(","));
      } else {
        this.c.header(key, headers[key]);
      }
    }
  }

  override endWithData(contentType: string, content: unknown): void {
    this.c.header("Access-Control-Allow-Origin", "*");
    this.c.header("Content-Type", contentType);
    this.c.status(200);
    if (contentType === "application/json") {
      const r = this.c.json(content);
      this.onComplete?.(r);
    } else {
      if (typeof content === "string") {
        const r = this.c.text(content);
        this.onComplete?.(r);
      } else if (content instanceof ArrayBuffer) {
        const r = this.c.body(content);
        this.onComplete?.(r);
      }
    }
  }

  override endedWithError(err: unknown): void {
    try {
      const { message, status, headers } = this.onError(this, err);
      if (headers) this.setResHeaders(headers);
      this.c.status(status as any);
      const r = this.c.text(message);
      this.onComplete?.(r);
    } catch (err) {
      HonoHttpContext.onError(err);
      this.c.status(500);
      const r = this.c.text("Unknown Server Error!");
      this.onComplete?.(r);
    }
  }
}

// Note: Hono SSE works differently via the 'hono/streaming' helper.
// This implementation assumes standard ReadableStream usage.
export class HonoSseContext extends R.SseContext {
  private controller?: ReadableStreamDefaultController;

  constructor(
    requestId: string,
    readonly c: Context,
    readonly onError: (context: HonoSseContext, err: unknown) => string,
  ) {
    super(requestId, `${c.req.method}, ${c.req.url}`);
    HonoState.set(this, [c]);
  }

  static async createHandler(
    onSseReq: GenSseContext,
    sse: R.FuncSseExported<R.SseInput, R.SseOutput, R.SseTypes>,
    c: Context,
  ): Promise<any> {
    const context = await onSseReq(c);
    const now = Date.now();
    context.logDebug("Req(🔁)", c.req.url);
    const executor = new R.SseExecutor(context, sse);
    executor.start(); // Non-blocking
    context.logDebug("Req(🔚).time(ms)", Date.now() - now);
    return context.getResponse(() => executor.cancel());
  }

  override req(): {
    path: Record<string, string>;
    query: Record<string, string | string[]>;
  } {
    return {
      path: this.c.req.param(),
      query: this.c.req.query(),
    };
  }

  override send(data: string): void {
    this.controller?.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
  }

  override endedWithError(err: unknown): void {
    this.send(this.onError(this, err));
    this.controller?.close();
  }

  override endedWithSuccess(): void {
    this.controller?.close();
  }

  getResponse(onCancel?: () => void): Response {
    const stream = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: onCancel,
    });
    return this.c.body(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}

export type GenHttpContext = (
  c: Context,
) => HonoHttpContext | Promise<HonoHttpContext>;
export type GenSseContext = (
  c: Context,
) => HonoSseContext | Promise<HonoSseContext>;

export function serve({
  bundle,
  onHttpReq,
  onSseReq,
}: {
  bundle: Record<string, R.EndpointBuild>;
  onHttpReq?: GenHttpContext;
  onSseReq?: GenSseContext;
}): Hono {
  const app = new Hono();
  for (const build of Object.values(bundle).sort(
    (x, y) => x.node.docsOrder - y.node.docsOrder,
  )) {
    let handler;
    if (build.node instanceof R.FuncHttp) {
      if (!onHttpReq) throw new Error("Need [onHttpReq]");
      handler = HonoHttpContext.createHandler.bind(
        HonoHttpContext,
        onHttpReq,
        build as R.FuncHttpExported<R.HttpInput, R.HttpOutput, R.HttpTypes>,
      );
    } else {
      if (!onSseReq) throw new Error("Need [onSseReq]");
      handler = HonoSseContext.createHandler.bind(
        HonoSseContext,
        onSseReq,
        build as R.FuncSseExported<R.SseInput, R.SseOutput, R.SseTypes>,
      );
    }
    for (const path of build.node.paths) {
      for (const method of build.node.methods) {
        if (build.node instanceof R.FuncHttp) {
          (app as any)[method](pathParser(path, build.node.reqPath), handler);
        } else {
          (app as any)[method](pathParser(path, build.node.reqPath), handler);
        }
      }
    }
  }
  return app;
}
