import { ErrorRequestHandler } from 'express';
import { HttpError } from '../../src/util';

/** The same HttpError -> status mapping the real app uses, for tiny test apps. */
export const errorHandlerFor = (): ErrorRequestHandler => (err, _req, res, _next) => {
  if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
  res.status(500).json({ error: 'Internal server error' });
};
