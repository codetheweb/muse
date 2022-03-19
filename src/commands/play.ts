import {AutocompleteInteraction, CommandInteraction} from 'discord.js';
import {URL} from 'url';
import {SlashCommandBuilder} from '@discordjs/builders';
import {inject, injectable} from 'inversify';
import Spotify from 'spotify-web-api-node';
import Command from '.';
import {TYPES} from '../types.js';
import ThirdParty from '../services/third-party.js';
import getYouTubeAndSpotifySuggestionsFor from '../utils/get-youtube-and-spotify-suggestions-for.js';
import KeyValueCacheProvider from '../services/key-value-cache.js';
import {ONE_HOUR_IN_SECONDS} from '../utils/constants.js';
import AddQueryToQueue from '../services/add-query-to-queue.js';

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('play')
    .setDescription('Spielt den Song.')
    .addStringOption(option => option
      .setName('query')
      .setDescription('YouTube Link, Spotify Link, oder such was.')
      .setAutocomplete(true)
      .setRequired(true))
    .addBooleanOption(option => option
      .setName('immediate')
      .setDescription('Fügt den Song ganz an die Spitze'))
    .addBooleanOption(option => option
      .setName('shuffle')
      .setDescription('Lass mich entscheiden was zuerst kommt, wenn du mehrere Songs hinzufügst'))
    .addBooleanOption(option => option
      .setName('split')
      .setDescription('Splittet den Song wenn er mehrere Kapitel hat'));

  public requiresVC = true;

  private readonly spotify: Spotify;
  private readonly cache: KeyValueCacheProvider;
  private readonly addQueryToQueue: AddQueryToQueue;

  constructor(@inject(TYPES.ThirdParty) thirdParty: ThirdParty, @inject(TYPES.KeyValueCache) cache: KeyValueCacheProvider, @inject(TYPES.Services.AddQueryToQueue) addQueryToQueue: AddQueryToQueue) {
    this.spotify = thirdParty.spotify;
    this.cache = cache;
    this.addQueryToQueue = addQueryToQueue;
  }

  // eslint-disable-next-line complexity
  public async execute(interaction: CommandInteraction): Promise<void> {
    const query = interaction.options.getString('query')!;

    await this.addQueryToQueue.addToQueue({
      interaction,
      query: query.trim(),
      addToFrontOfQueue: interaction.options.getBoolean('immediate') ?? false,
      shuffleAdditions: interaction.options.getBoolean('shuffle') ?? false,
      shouldSplitChapters: interaction.options.getBoolean('split') ?? false,
    });
  }

  public async handleAutocompleteInteraction(interaction: AutocompleteInteraction): Promise<void> {
    const query = interaction.options.getString('query')?.trim();

    if (!query || query.length === 0) {
      await interaction.respond([]);
      return;
    }

    try {
      // Don't return suggestions for URLs
      // eslint-disable-next-line no-new
      new URL(query);
      await interaction.respond([]);
      return;
    } catch {}

    const suggestions = await this.cache.wrap(
      getYouTubeAndSpotifySuggestionsFor,
      query,
      this.spotify,
      10,
      {
        expiresIn: ONE_HOUR_IN_SECONDS,
        key: `autocomplete:${query}`,
      });

    await interaction.respond(suggestions);
  }
}
