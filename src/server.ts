import { app } from "./app.js";

const PORT: number = 3001;
const HOST: string = "127.0.0.1";

app.listen(PORT, HOST, () =>
  console.log(`Server securely running at http://${HOST}:${PORT}/`),
);
