export async function runLegacy(handler, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  let statusCode = 200;
  let response;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      response = Response.json(payload, {
        status: statusCode,
        headers: { "Cache-Control": "no-store" }
      });
      return response;
    }
  };

  try {
    await handler({ body }, res);
    return response || Response.json(
      { error: "The API handler did not produce a response." },
      { status: 500 }
    );
  } catch (error) {
    return Response.json(
      { error: "Internal API error.", detail: String(error?.message || error).slice(0, 240) },
      { status: 500 }
    );
  }
}
