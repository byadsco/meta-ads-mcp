import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { getFirestore } from "./firestore.js";
import { logger } from "../utils/logger.js";

const COLLECTION = "mcp_clients";

/**
 * Stamp the registration timestamp on the doc so an operator can later
 * audit / clean up clients that haven't been used in N days (CODE-B8).
 * Stored alongside the original client info — the SDK ignores the
 * extra field on read.
 */
interface StoredClient extends OAuthClientInformationFull {
  registered_at?: number;
}

export class FirestoreClientsStore implements OAuthRegisteredClientsStore {
  private get collection() {
    return getFirestore().collection(COLLECTION);
  }

  async getClient(
    clientId: string,
  ): Promise<OAuthClientInformationFull | undefined> {
    const snap = await this.collection.doc(clientId).get();
    if (!snap.exists) return undefined;
    return snap.data() as OAuthClientInformationFull;
  }

  async registerClient(
    client: OAuthClientInformationFull,
  ): Promise<OAuthClientInformationFull> {
    const stored: StoredClient = {
      ...client,
      registered_at: Math.floor(Date.now() / 1000),
    };
    await this.collection.doc(client.client_id).set(stored);
    logger.info(
      { clientId: client.client_id, clientName: client.client_name },
      "Registered OAuth client",
    );
    return client;
  }
}

export class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private static MAX = 100;
  private clients = new Map<string, OAuthClientInformationFull>();

  async getClient(
    clientId: string,
  ): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId);
  }

  async registerClient(
    client: OAuthClientInformationFull,
  ): Promise<OAuthClientInformationFull> {
    if (
      this.clients.size >= InMemoryClientsStore.MAX &&
      !this.clients.has(client.client_id)
    ) {
      throw new Error("Maximum number of registered clients reached");
    }
    this.clients.set(client.client_id, client);
    return client;
  }
}
