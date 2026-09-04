export interface JobOfferDraft {
  id: string;
  text: string;
}

interface Props {
  offers: JobOfferDraft[];
  onChange: (offers: JobOfferDraft[]) => void;
}

export function JobOfferInput({ offers, onChange }: Props) {
  const updateOffer = (id: string, text: string) => {
    onChange(offers.map((o) => (o.id === id ? { ...o, text } : o)));
  };

  const removeOffer = (id: string) => {
    onChange(offers.filter((o) => o.id !== id));
  };

  const addOffer = () => {
    onChange([...offers, { id: crypto.randomUUID(), text: "" }]);
  };

  return (
    <div className="job-offers">
      {offers.map((offer, index) => (
        <div key={offer.id} className="job-offers__item">
          <textarea
            placeholder={`Paste job offer ${index + 1}`}
            value={offer.text}
            onChange={(e) => updateOffer(offer.id, e.target.value)}
            rows={4}
          />
          {offers.length > 1 && (
            <button
              type="button"
              className="job-offers__remove"
              onClick={() => removeOffer(offer.id)}
              aria-label="Remove this job offer"
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <button type="button" className="job-offers__add" onClick={addOffer}>
        + Add another offer
      </button>
    </div>
  );
}
