import { type Static, type TSchema } from "typebox";
import { ParseError, Value } from "typebox/value";

export function bitbucketBasicAuthorization(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}

export async function decodeResponseJson<Schema extends TSchema>(response: Response, schema: Schema): Promise<Static<Schema> | undefined> {
  try {
    const encoded: unknown = await response.json();
    return Value.Parse(schema, encoded);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ParseError) return undefined;
    throw error;
  }
}
