export class ApiError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}
export const fail = (status, code, message) => { throw new ApiError(status, code, message); };
